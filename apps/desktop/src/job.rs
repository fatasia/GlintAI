use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::Child,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

pub struct ProcessJob(OwnedHandle);

impl ProcessJob {
    pub fn new() -> io::Result<Self> {
        // Unnamed, non-inheritable handle owned only by the native host.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
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
        let success = unsafe {
            AssignProcessToJobObject(
                self.0.as_raw_handle() as HANDLE,
                child.as_raw_handle() as HANDLE,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
