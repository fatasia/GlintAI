use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::Duration,
    process::Child,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME,
    },
};

pub struct ProcessJob(OwnedHandle);

impl ProcessJob {
    pub fn new() -> io::Result<Self> {
        Self::create(None, None)
    }

    /// Caps committed memory across associated processes. This primitive alone
    /// is not a safe launcher: callers must assign before untrusted code runs.
    #[allow(dead_code)]
    pub fn with_memory_limit(bytes: usize) -> io::Result<Self> {
        if bytes == 0 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "job memory limit must be positive")); }
        Self::create(Some(bytes), None)
    }

    /// Limits aggregate user-mode CPU time, not wall time or CPU rate.
    #[allow(dead_code)]
    pub fn with_limits(bytes: usize, cpu_time: Duration) -> io::Result<Self> {
        if bytes == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "job memory limit must be positive"));
        }
        let ticks = cpu_time.as_nanos() / 100;
        if ticks == 0 || ticks > i64::MAX as u128 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "job CPU time must fit in positive 100ns ticks"));
        }
        Self::create(Some(bytes), Some(ticks as i64))
    }

    fn create(memory_limit: Option<usize>, cpu_ticks: Option<i64>) -> io::Result<Self> {
        // Unnamed, non-inheritable handle owned only by the native host.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Some(bytes) = memory_limit {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.JobMemoryLimit = bytes;
        }
        if let Some(ticks) = cpu_ticks {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_TIME;
            limits.BasicLimitInformation.PerJobUserTimeLimit = ticks;
        }
        let success = unsafe {
            SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(raw);
            }
            return Err(error);
        }
        // SAFETY: CreateJobObjectW returned a unique valid handle, now transferred to RAII.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(raw.cast()) }))
    }

    pub fn assign(&self, child: &Child) -> io::Result<()> {
        self.assign_handle(child.as_raw_handle() as HANDLE)
    }

    pub(crate) fn assign_handle(&self, process: HANDLE) -> io::Result<()> {
        let success = unsafe {
            AssignProcessToJobObject(
                self.0.as_raw_handle() as HANDLE,
                process,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}


#[cfg(test)]
mod tests {
    use super::ProcessJob;
    use std::{io::{Read, Write}, process::{Command, Stdio}, time::{Duration, Instant}};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::{Memory::{VirtualAlloc, VirtualFree, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE},
            Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}},
    };

    fn child(name: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", name, "--ignored", "--nocapture"]);
        command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        command
    }
    fn release(child: &mut std::process::Child) { child.stdin.take().unwrap().write_all(b"x").unwrap(); }
    fn wait_release() { let mut value = [0]; std::io::stdin().read_exact(&mut value).unwrap(); }

    #[test]
    #[ignore]
    fn allocation_child() {
        wait_release();
        // Allocation is attempted only after the parent assigns this process to the job.
        let allocated = unsafe { VirtualAlloc(std::ptr::null(), 512 * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE) };
        if !allocated.is_null() { unsafe { VirtualFree(allocated, 0, MEM_RELEASE); } panic!("job allowed allocation beyond its committed-memory limit"); }
    }
    #[test]
    fn memory_limit_denies_commit_after_assignment() {
        assert!(ProcessJob::with_memory_limit(0).is_err());
        let job = ProcessJob::with_memory_limit(128 * 1024 * 1024).unwrap();
        let mut process = child("job::tests::allocation_child").spawn().unwrap();
        job.assign(&process).unwrap(); release(&mut process);
        let output = process.wait_with_output().unwrap();
        assert!(output.status.success(), "child failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    #[test]
    #[ignore]
    fn cpu_busy_child() {
        wait_release();
        loop { std::hint::black_box(1u64.wrapping_mul(9)); }
    }

    #[test]
    fn job_cpu_time_limit_terminates_owned_busy_child() {
        assert!(ProcessJob::with_limits(1, Duration::ZERO).is_err());
        assert!(ProcessJob::with_limits(1, Duration::from_nanos(99)).is_err());
        assert!(ProcessJob::with_limits(1, Duration::MAX).is_err());
        let job = ProcessJob::with_limits(128 * 1024 * 1024, Duration::from_millis(200)).unwrap();
        let mut process = child("job::tests::cpu_busy_child").spawn().unwrap();
        job.assign(&process).unwrap();
        release(&mut process);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = process.try_wait().unwrap() {
                assert!(!status.success(), "busy worker escaped CPU limit");
                break;
            }
            if Instant::now() >= deadline {
                drop(job);
                let _ = process.wait();
                panic!("CPU limit did not stop the owned worker within 10 seconds");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    #[ignore]
    fn tree_grandchild() { std::thread::sleep(Duration::from_secs(60)); }
    #[test]
    #[ignore]
    fn tree_child() {
        wait_release();
        let mut spawned = child("job::tests::tree_grandchild").spawn().unwrap();
        std::fs::write(std::env::var_os("GLINT_TEST_PID_FILE").unwrap(), spawned.id().to_string()).unwrap();
        spawned.wait().unwrap();
    }
    #[test]
    fn closing_job_terminates_associated_process_tree() {
        let file = std::env::temp_dir().join(format!("glint-job-test-{}-{}.pid", std::process::id(), std::thread::current().name().unwrap_or("test").replace(':', "-")));
        let _ = std::fs::remove_file(&file);
        let job = ProcessJob::new().unwrap();
        let mut process = child("job::tests::tree_child").env("GLINT_TEST_PID_FILE", &file).spawn().unwrap();
        job.assign(&process).unwrap(); release(&mut process);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !file.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
        let pid: u32 = std::fs::read_to_string(&file).expect("grandchild did not start").parse().unwrap();
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null(), "could not open grandchild");
        drop(job);
        assert_eq!(unsafe { WaitForSingleObject(handle, 10000) }, WAIT_OBJECT_0, "grandchild survived job closure");
        unsafe { CloseHandle(handle); }
        process.wait().unwrap();
        std::fs::remove_file(file).unwrap();
    }
}
