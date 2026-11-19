#![cfg(windows)]

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, Prefix};
use std::ptr::{null, null_mut};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformation, NtCreateFile, NtSetInformationFile, FILE_CREATE, FILE_DIRECTORY_FILE,
    FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
    FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    RtlNtStatusToDosError, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const LIMIT: usize = 32 * 1024 * 1024;
const DRIVE_FIXED: u32 = 3;

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}
fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().collect()
}

fn asset_name(name: &str) -> io::Result<()> {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return Err(invalid("invalid asset name"));
    };
    if ext == "json" {
        if stem.is_empty()
            || name.encode_utf16().count() > 255
            || stem.ends_with([' ', '.'])
            || name
                .chars()
                .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        {
            return Err(invalid("invalid document name"));
        }
        let device = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(
            device.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        ) {
            return Err(invalid("reserved document name"));
        }
        return Ok(());
    }
    if stem.is_empty()
        || stem.len() > 100
        || !stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !matches!(ext, "png" | "jpg" | "webp" | "mp4" | "mp3" | "wav")
    {
        return Err(invalid("invalid asset name"));
    }
    let upper = stem.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err(invalid("reserved asset name"));
    }
    Ok(())
}

fn information(handle: &OwnedHandle, directory: bool) -> io::Result<()> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(raw(handle), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "reparse point, hard link, or unexpected file type",
        ));
    }
    Ok(())
}

fn relative(
    parent: &OwnedHandle,
    name: &OsStr,
    access: u32,
    disposition: u32,
    directory: bool,
    share: u32,
) -> io::Result<OwnedHandle> {
    let mut chars = wide(name);
    if chars.is_empty()
        || chars.len() > 255
        || chars
            .iter()
            .any(|c| *c == 0 || *c == b'\\' as u16 || *c == b'/' as u16 || *c == b':' as u16)
    {
        return Err(invalid("invalid path component"));
    }
    let length = (chars.len() * 2) as u16;
    let unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: chars.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: raw(parent),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut status_block = IO_STATUS_BLOCK::default();
    let mut handle = null_mut();
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attributes,
            &mut status_block,
            null(),
            0,
            share,
            disposition,
            options,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
    information(&handle, directory)?;
    Ok(handle)
}

/// A pinned, local drive-rooted directory chain. No process-global path resolution is used after opening.
/// The caller must trust the selected drive and directory ACLs; other writers are not authenticated.
pub struct SecureAssets {
    directories: Vec<OwnedHandle>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Publish {
    Created,
    AlreadyIdentical,
}

impl SecureAssets {
    pub fn open(root: &Path) -> io::Result<Self> {
        let mut components = root.components();
        let drive = match components.next() {
            Some(Component::Prefix(p)) => match p.kind() {
                Prefix::Disk(d) => d,
                _ => return Err(invalid("root must be an absolute local drive path")),
            },
            _ => return Err(invalid("root must be an absolute local drive path")),
        };
        if components.next() != Some(Component::RootDir) {
            return Err(invalid("root must be absolute"));
        }
        let drive_path: Vec<u16> = format!("{}:\\", drive as char)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // Network and removable volumes do not satisfy the local fixed-volume assumption.
        if unsafe { GetDriveTypeW(drive_path.as_ptr()) } != DRIVE_FIXED {
            return Err(invalid("root must be on a fixed local drive"));
        }
        let handle = unsafe {
            CreateFileW(
                drive_path.as_ptr(),
                FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let first = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
        information(&first, true)?;
        let mut directories = vec![first];
        for component in components {
            let Component::Normal(name) = component else {
                return Err(invalid("invalid root component"));
            };
            let next = relative(
                directories.last().unwrap(),
                name,
                FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
                FILE_OPEN,
                true,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
            )?;
            directories.push(next);
        }
        if directories.len() == 1 {
            return Err(invalid("drive root cannot be used as an asset directory"));
        }
        Ok(Self { directories })
    }

    fn root(&self) -> &OwnedHandle {
        self.directories.last().unwrap()
    }

    pub fn read(&self, name: &str) -> io::Result<Vec<u8>> {
        asset_name(name)?;
        let handle = relative(
            self.root(),
            OsStr::new(name),
            GENERIC_READ,
            FILE_OPEN,
            false,
            FILE_SHARE_READ,
        )?;
        let file = File::from(handle);
        let mut bytes = Vec::new();
        file.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > LIMIT {
            return Err(invalid("asset exceeds size limit"));
        }
        Ok(bytes)
    }

    /// Writes and flushes an exclusive temporary handle, then renames it without replacement.
    /// Existing content is compared with the requested bytes; different content is a conflict.
    pub fn publish(&self, name: &str, bytes: &[u8]) -> io::Result<Publish> {
        asset_name(name)?;
        if bytes.is_empty() || bytes.len() > LIMIT {
            return Err(invalid("invalid asset size"));
        }
        let temp = format!(".glint-incoming-{}", uuid::Uuid::new_v4());
        let handle = relative(
            self.root(),
            OsStr::new(&temp),
            GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
            FILE_CREATE,
            false,
            0,
        )?;
        let mut file = File::from(handle);
        let result: io::Result<Publish> = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            rename_no_replace(&file, self.root(), name)?;
            Ok(Publish::Created)
        })();
        if result.is_err() {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            if unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle().cast(),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        drop(file);
        match result {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if self.read(name)? == bytes {
                    Ok(Publish::AlreadyIdentical)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "asset content conflict; existing file preserved",
                    ))
                }
            }
            other => other,
        }
    }
}

fn rename_no_replace(file: &File, root: &OwnedHandle, name: &str) -> io::Result<()> {
    let chars: Vec<u16> = name.encode_utf16().collect();
    let offset = offset_of!(FILE_RENAME_INFORMATION, FileName);
    let size = offset + chars.len() * 2;
    // usize storage guarantees alignment of the variable-length Win32 structure.
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = raw(root);
        (*info).FileNameLength = (chars.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            chars.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            chars.len(),
        );
        let mut ios = IO_STATUS_BLOCK::default();
        let status = NtSetInformationFile(
            file.as_raw_handle().cast(),
            &mut ios,
            info.cast(),
            size as u32,
            FileRenameInformation,
        );
        if status < 0 {
            return Err(io::Error::from_raw_os_error(
                RtlNtStatusToDosError(status) as i32
            ));
        }
    }
    Ok(())
}
