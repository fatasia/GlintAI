use crate::job::ProcessJob;
use std::{
    collections::VecDeque,
    ffi::{OsStr, OsString},
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::Threading::{
        CreateProcessW, ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
    },
};

/// A bounded, separately-owned admission queue for resource-limited processes.
/// It is deliberately not connected to Web rendering: Job Objects do not sandbox
/// filesystem or network access. Call `poll` regularly to enforce wall timeouts.
pub struct RenderQueue {
    max_queued: usize,
    pending: VecDeque<RenderRequest>,
    active: Option<RunningRender>,
    events: Vec<RenderEvent>,
}

pub struct RenderRequest {
    pub id: u64,
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub working_dir: PathBuf,
    pub memory_limit: usize,
    pub cpu_time_limit: Duration,
    pub timeout: Duration,
}

struct RunningRender {
    request: RenderRequest,
    process: RenderProcess,
    started: Instant,
}

#[derive(Debug)]
pub enum RenderOutcome {
    Exited(u32),
    Cancelled,
    TimedOut,
    Failed(io::Error),
}

#[derive(Debug)]
pub struct RenderEvent {
    pub id: u64,
    pub outcome: RenderOutcome,
}

impl RenderQueue {
    pub fn new(max_queued: usize) -> Self {
        Self {
            max_queued,
            pending: VecDeque::new(),
            active: None,
            events: Vec::new(),
        }
    }

    pub fn submit(&mut self, request: RenderRequest) -> io::Result<()> {
        if request.timeout.is_zero() || request.memory_limit == 0 || request.cpu_time_limit.as_nanos() < 100 || request.cpu_time_limit.as_nanos() / 100 > i64::MAX as u128 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "timeout, memory limit, and valid CPU time limit are required",
            ));
        }
        if self
            .active
            .as_ref()
            .is_some_and(|run| run.request.id == request.id)
            || self.pending.iter().any(|item| item.id == request.id)
        {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "render job ID is already queued or running",
            ));
        }
        // Without an active job, the first pending item owns the active slot.
        let waiting = self
            .pending
            .len()
            .saturating_sub(usize::from(self.active.is_none()));
        if waiting >= self.max_queued && (self.active.is_some() || !self.pending.is_empty()) {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "render queue is full",
            ));
        }
        self.pending.push_back(request);
        Ok(())
    }

    pub fn cancel(&mut self, id: u64) -> bool {
        if self.active.as_ref().is_some_and(|run| run.request.id == id) {
            drop(self.active.take());
        } else if let Some(index) = self.pending.iter().position(|item| item.id == id) {
            self.pending.remove(index);
        } else {
            return false;
        }
        self.events.push(RenderEvent {
            id,
            outcome: RenderOutcome::Cancelled,
        });
        true
    }

    pub fn poll(&mut self) -> Vec<RenderEvent> {
        if let Some(run) = &self.active {
            let outcome = match run.process.wait(0) {
                Ok(true) => Some(
                    run.process
                        .exit_code()
                        .map(RenderOutcome::Exited)
                        .unwrap_or_else(RenderOutcome::Failed),
                ),
                Ok(false) if run.started.elapsed() >= run.request.timeout => {
                    Some(RenderOutcome::TimedOut)
                }
                Ok(false) => None,
                Err(error) => Some(RenderOutcome::Failed(error)),
            };
            if let Some(outcome) = outcome {
                let id = run.request.id;
                // Close the Job before admitting another job, including descendants.
                drop(self.active.take());
                self.events.push(RenderEvent { id, outcome });
            }
        }
        while self.active.is_none() {
            let Some(request) = self.pending.pop_front() else {
                break;
            };
            match RenderProcess::launch(
                &request.executable,
                &request.args,
                &request.working_dir,
                request.memory_limit,
                request.cpu_time_limit,
            ) {
                Ok(process) => {
                    self.active = Some(RunningRender {
                        request,
                        process,
                        started: Instant::now(),
                    })
                }
                Err(error) => self.events.push(RenderEvent {
                    id: request.id,
                    outcome: RenderOutcome::Failed(error),
                }),
            }
        }
        std::mem::take(&mut self.events)
    }
}

/// A resource-limited process tree, not a filesystem, identity, or network sandbox.
/// Dropping this value closes the Job and terminates its remaining processes.
pub struct RenderProcess {
    process: OwnedHandle,
    _job: ProcessJob,
}

impl RenderProcess {
    pub fn launch(
        executable: &Path,
        args: &[OsString],
        working_dir: &Path,
        memory_limit: usize,
        cpu_time_limit: Duration,
    ) -> io::Result<Self> {
        launch_with(
            executable,
            args,
            working_dir,
            memory_limit,
            cpu_time_limit,
            |job, process| job.assign_handle(process),
        )
    }

    fn exit_code(&self) -> io::Result<u32> {
        let mut code = 0;
        if unsafe {
            windows_sys::Win32::System::Threading::GetExitCodeProcess(
                self.process.as_raw_handle() as HANDLE,
                &mut code,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(code)
        }
    }

    /// Returns true if the root process has exited before the timeout.
    pub fn wait(&self, timeout_ms: u32) -> io::Result<bool> {
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        match unsafe { WaitForSingleObject(self.process.as_raw_handle() as HANDLE, timeout_ms) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut encoded: Vec<u16> = value.encode_wide().collect();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows process strings cannot contain NUL",
        ));
    }
    encoded.push(0);
    Ok(encoded)
}

// Quote according to the Windows C runtime argument parsing rules.
fn append_argument(command: &mut Vec<u16>, argument: &OsStr) -> io::Result<()> {
    let encoded = wide(argument)?;
    command.push(b'"' as u16);
    let mut slashes = 0;
    for &c in &encoded[..encoded.len() - 1] {
        if c == b'\\' as u16 {
            slashes += 1;
        } else {
            command.extend(std::iter::repeat_n(b'\\' as u16, if c == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            }));
            command.push(c);
            slashes = 0;
        }
    }
    command.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    command.push(b'"' as u16);
    Ok(())
}

fn launch_with<F>(
    executable: &Path,
    args: &[OsString],
    working_dir: &Path,
    memory_limit: usize,
    cpu_time_limit: Duration,
    assign: F,
) -> io::Result<RenderProcess>
where
    F: FnOnce(&ProcessJob, HANDLE) -> io::Result<()>,
{
    if !executable.is_absolute() || !working_dir.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable and working directory must be absolute",
        ));
    }
    let application = wide(executable.as_os_str())?;
    let directory = wide(working_dir.as_os_str())?;
    let mut command = Vec::new();
    append_argument(&mut command, executable.as_os_str())?;
    for arg in args {
        command.push(b' ' as u16);
        append_argument(&mut command, arg)?;
    }
    command.push(0);
    let job = ProcessJob::with_limits(memory_limit, cpu_time_limit)?;
    let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..STARTUPINFOW::default() };
    let mut info = PROCESS_INFORMATION::default();
    // Do not implicitly expose the host's environment or secrets to the worker.
    let environment = [0u16, 0];
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr().cast(),
            directory.as_ptr(),
            &startup,
            &mut info,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    // Both handles are unique and non-inheritable; no untrusted instructions have run yet.
    let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess.cast()) };
    let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread.cast()) };
    let raw_process = process.as_raw_handle() as HANDLE;
    let result = assign(&job, raw_process).and_then(|()| {
        if unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) } == u32::MAX {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    });
    if let Err(error) = result {
        // Assignment can fail, so closing the Job alone is not sufficient.
        unsafe {
            TerminateProcess(raw_process, 1);
            WaitForSingleObject(raw_process, 5000);
        }
        return Err(error);
    }
    Ok(RenderProcess { process, _job: job })
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, WAIT_OBJECT_0},
        System::{
            JobObjects::IsProcessInJob,
            Memory::{
                VirtualAlloc, VirtualFree, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
            },
            Threading::{GetCurrentProcess, GetExitCodeProcess},
        },
    };

    fn exe() -> std::path::PathBuf {
        std::env::current_exe().unwrap()
    }
    fn directory() -> std::path::PathBuf {
        std::env::temp_dir()
    }
    fn args(name: &str) -> Vec<OsString> {
        ["--exact", name, "--ignored", "--nocapture"]
            .into_iter()
            .map(OsString::from)
            .collect()
    }
    fn exit_code(process: &RenderProcess) -> u32 {
        let mut code = 0;
        assert_ne!(
            unsafe { GetExitCodeProcess(process.process.as_raw_handle() as HANDLE, &mut code) },
            0
        );
        code
    }

    #[test]
    #[ignore]
    fn limited_child() {
        let mut in_job = 0;
        assert!(std::env::var_os("GLINT_RENDER_TEST_SECRET").is_none());
        assert_ne!(
            unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) },
            0
        );
        assert_ne!(in_job, 0);
        let allocated = unsafe {
            VirtualAlloc(
                std::ptr::null(),
                512 * 1024 * 1024,
                MEM_RESERVE | MEM_COMMIT,
                PAGE_READWRITE,
            )
        };
        if !allocated.is_null() {
            unsafe {
                VirtualFree(allocated, 0, MEM_RELEASE);
            }
            panic!("allocation exceeded the job limit");
        }
    }

    #[test]
    #[ignore]
    fn sleeping_child() {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    #[test]
    fn launched_child_is_already_limited() {
        let process = RenderProcess::launch(
            &exe(),
            &args("render_launcher::tests::limited_child"),
            &directory(),
            128 * 1024 * 1024,
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(process.wait(10000).unwrap());
        assert_eq!(exit_code(&process), 0);
    }

    #[test]
    fn assignment_failure_terminates_suspended_process() {
        let mut observed = None;
        let result = launch_with(
            &exe(),
            &args("render_launcher::tests::sleeping_child"),
            &directory(),
            128 * 1024 * 1024,
            Duration::from_secs(10),
            |_, process| {
                let mut duplicate = std::ptr::null_mut();
                assert_ne!(
                    unsafe {
                        DuplicateHandle(
                            GetCurrentProcess(),
                            process,
                            GetCurrentProcess(),
                            &mut duplicate,
                            0,
                            0,
                            DUPLICATE_SAME_ACCESS,
                        )
                    },
                    0
                );
                observed = Some(unsafe { OwnedHandle::from_raw_handle(duplicate.cast()) });
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected assignment failure",
                ))
            },
        );
        assert_eq!(
            result.err().unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
        let handle = observed.unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 10000) },
            WAIT_OBJECT_0
        );
    }

    #[test]
    fn dropping_job_terminates_owned_child() {
        let process = RenderProcess::launch(
            &exe(),
            &args("render_launcher::tests::sleeping_child"),
            &directory(),
            128 * 1024 * 1024,
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(!process.wait(50).unwrap());
        let mut duplicate = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    process.process.as_raw_handle() as HANDLE,
                    GetCurrentProcess(),
                    &mut duplicate,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            },
            0
        );
        let handle = unsafe { OwnedHandle::from_raw_handle(duplicate.cast()) };
        drop(process);
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 10000) },
            WAIT_OBJECT_0
        );
    }

    #[test]
    fn independent_jobs_do_not_kill_each_other() {
        let first = RenderProcess::launch(
            &exe(),
            &args("render_launcher::tests::sleeping_child"),
            &directory(),
            128 * 1024 * 1024,
            Duration::from_secs(10),
        )
        .unwrap();
        let second = RenderProcess::launch(
            &exe(),
            &args("render_launcher::tests::sleeping_child"),
            &directory(),
            128 * 1024 * 1024,
            Duration::from_secs(10),
        )
        .unwrap();
        drop(first);
        assert!(!second.wait(100).unwrap());
    }

    fn request(id: u64, name: &str, timeout: Duration) -> RenderRequest {
        RenderRequest {
            id,
            executable: exe(),
            args: args(name),
            working_dir: directory(),
            memory_limit: 128 * 1024 * 1024,
            cpu_time_limit: Duration::from_secs(10),
            timeout,
        }
    }

    fn await_events(queue: &mut RenderQueue, expected: usize) -> Vec<RenderEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut events = Vec::new();
        while events.len() < expected && Instant::now() < deadline {
            events.extend(queue.poll());
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(events.len(), expected, "timed out waiting for queue events");
        events
    }

    fn duplicate_running(queue: &RenderQueue) -> OwnedHandle {
        let mut handle = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    queue
                        .active
                        .as_ref()
                        .unwrap()
                        .process
                        .process
                        .as_raw_handle() as HANDLE,
                    GetCurrentProcess(),
                    &mut handle,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            },
            0
        );
        unsafe { OwnedHandle::from_raw_handle(handle.cast()) }
    }

    #[test]
    #[ignore]
    fn cpu_child() {
        loop { std::hint::black_box(1u64.wrapping_mul(9)); }
    }

    #[test]
    fn queue_cpu_limit_stops_worker_and_advances() {
        let mut queue = RenderQueue::new(1);
        let mut busy = request(1, "render_launcher::tests::cpu_child", Duration::from_secs(10));
        busy.cpu_time_limit = Duration::from_millis(200);
        queue.submit(busy).unwrap();
        queue.submit(request(2, "render_launcher::tests::limited_child", Duration::from_secs(10))).unwrap();
        let events = await_events(&mut queue, 2);
        assert!(matches!(events[0], RenderEvent { id: 1, outcome: RenderOutcome::Exited(0xC0000044) }), "expected STATUS_QUOTA_EXCEEDED from the CPU limit: {:?}", events[0]);
        assert!(matches!(events[1], RenderEvent { id: 2, outcome: RenderOutcome::Exited(0) }));
    }

    #[test]
    fn queue_enforces_limit_fifo_and_real_memory_limit() {
        let mut queue = RenderQueue::new(1);
        queue
            .submit(request(
                1,
                "render_launcher::tests::sleeping_child",
                Duration::from_secs(30),
            ))
            .unwrap();
        assert!(queue.poll().is_empty());
        let first_handle = duplicate_running(&queue);
        queue
            .submit(request(
                2,
                "render_launcher::tests::limited_child",
                Duration::from_secs(10),
            ))
            .unwrap();
        assert_eq!(
            queue
                .submit(request(
                    3,
                    "render_launcher::tests::limited_child",
                    Duration::from_secs(10)
                ))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            queue
                .submit(request(
                    2,
                    "render_launcher::tests::limited_child",
                    Duration::from_secs(10)
                ))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(queue.cancel(1));
        assert_eq!(
            unsafe { WaitForSingleObject(first_handle.as_raw_handle() as HANDLE, 10000) },
            WAIT_OBJECT_0
        );
        let events = await_events(&mut queue, 2);
        assert!(matches!(
            events[0],
            RenderEvent {
                id: 1,
                outcome: RenderOutcome::Cancelled
            }
        ));
        assert!(matches!(
            events[1],
            RenderEvent {
                id: 2,
                outcome: RenderOutcome::Exited(0)
            }
        ));
    }

    #[test]
    fn queue_timeout_cancels_owned_process_and_advances_after_launch_failure() {
        let mut queue = RenderQueue::new(2);
        queue
            .submit(request(
                1,
                "render_launcher::tests::sleeping_child",
                Duration::from_millis(100),
            ))
            .unwrap();
        queue.poll();
        let handle = duplicate_running(&queue);
        let mut missing = request(
            2,
            "render_launcher::tests::limited_child",
            Duration::from_secs(1),
        );
        missing.executable = directory().join("glint-no-such-render-worker.exe");
        queue.submit(missing).unwrap();
        queue
            .submit(request(
                3,
                "render_launcher::tests::limited_child",
                Duration::from_secs(10),
            ))
            .unwrap();
        let events = await_events(&mut queue, 3);
        assert!(matches!(
            events[0],
            RenderEvent {
                id: 1,
                outcome: RenderOutcome::TimedOut
            }
        ));
        assert!(matches!(
            events[1],
            RenderEvent {
                id: 2,
                outcome: RenderOutcome::Failed(_)
            }
        ));
        assert!(matches!(
            events[2],
            RenderEvent {
                id: 3,
                outcome: RenderOutcome::Exited(0)
            }
        ));
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 10000) },
            WAIT_OBJECT_0
        );
    }

    #[test]
    fn queue_cancels_pending_and_rejects_invalid_requests() {
        let mut queue = RenderQueue::new(0);
        assert_eq!(
            queue
                .submit(request(1, "", Duration::ZERO))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        queue
            .submit(request(
                1,
                "render_launcher::tests::sleeping_child",
                Duration::from_secs(1),
            ))
            .unwrap();
        assert_eq!(
            queue
                .submit(request(2, "", Duration::from_secs(1)))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert!(queue.cancel(1));
        assert!(!queue.cancel(1));
        assert!(matches!(
            queue.poll()[0],
            RenderEvent {
                id: 1,
                outcome: RenderOutcome::Cancelled
            }
        ));
        assert!(queue.active.is_none());
    }

    #[test]
    #[ignore]
    fn failing_child() {
        panic!("intentional worker failure");
    }

    #[test]
    fn queue_reports_nonzero_exit_and_drop_kills_active_worker() {
        let mut queue = RenderQueue::new(0);
        queue
            .submit(request(
                1,
                "render_launcher::tests::failing_child",
                Duration::from_secs(10),
            ))
            .unwrap();
        let events = await_events(&mut queue, 1);
        assert!(
            matches!(events[0], RenderEvent { id: 1, outcome: RenderOutcome::Exited(code) } if code != 0)
        );
        queue
            .submit(request(
                2,
                "render_launcher::tests::sleeping_child",
                Duration::from_secs(30),
            ))
            .unwrap();
        queue.poll();
        let handle = duplicate_running(&queue);
        drop(queue);
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 10000) },
            WAIT_OBJECT_0
        );
    }

    #[test]
    fn quotes_windows_arguments() {
        fn quoted(value: &str) -> String {
            let mut output = Vec::new();
            append_argument(&mut output, OsStr::new(value)).unwrap();
            String::from_utf16(&output).unwrap()
        }
        assert_eq!(quoted(""), "\"\"");
        assert_eq!(quoted("a b"), "\"a b\"");
        assert_eq!(quoted("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quoted("a\\"), "\"a\\\\\"");
    }

    #[test]
    fn rejects_invalid_inputs_and_missing_executable() {
        assert_eq!(
            RenderProcess::launch(Path::new("relative.exe"), &[], &directory(), 1, Duration::from_secs(1))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            RenderProcess::launch(&exe(), &[], &directory(), 0, Duration::from_secs(1))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            RenderProcess::launch(&exe(), &[OsString::from("bad\0arg")], &directory(), 1, Duration::from_secs(1))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(RenderProcess::launch(
            &directory().join("glint-nonexistent-launcher-test.exe"),
            &[],
            &directory(),
            1024 * 1024,
            Duration::from_secs(1)
        )
        .is_err());
    }
}
