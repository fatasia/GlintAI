"""Non-production Windows AppContainer probe; no ACL or profile changes.

Creates a unique temporary profile, temp fixture, loopback listener and owned processes.
Deletes only the profile created by this invocation; never changes existing ACLs.
A passing probe is not an ADR-014 rendering sandbox or a reason to enable Web HTML.
"""
import ctypes as c
from ctypes import wintypes as w
import os
import pathlib
import socket
import tempfile
import uuid

if os.name != "nt":
    raise SystemExit("Windows only")

k = c.WinDLL("kernel32", use_last_error=True)
a = c.WinDLL("advapi32", use_last_error=True)
u = c.WinDLL("userenv", use_last_error=True)
HANDLE = w.HANDLE
SIZE = c.c_size_t

class SecurityCapabilities(c.Structure):
    _fields_ = [("sid", c.c_void_p), ("capabilities", c.c_void_p),
                ("count", w.DWORD), ("reserved", w.DWORD)]

class StartupInfo(c.Structure):
    _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
                ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
                ("xsize", w.DWORD), ("ysize", w.DWORD), ("xchars", w.DWORD),
                ("ychars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                ("show", w.WORD), ("reserved2_size", w.WORD),
                ("reserved2", c.c_void_p), ("stdin", HANDLE), ("stdout", HANDLE),
                ("stderr", HANDLE)]

class StartupInfoEx(c.Structure):
    _fields_ = [("startup", StartupInfo), ("attributes", c.c_void_p)]

class ProcessInformation(c.Structure):
    _fields_ = [("process", HANDLE), ("thread", HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]

u.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, c.POINTER(c.c_void_p)]
u.DeriveAppContainerSidFromAppContainerName.restype = c.c_long
u.CreateAppContainerProfile.argtypes = [w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, c.c_void_p, w.DWORD, c.POINTER(c.c_void_p)]
u.CreateAppContainerProfile.restype = c.c_long
u.DeleteAppContainerProfile.argtypes = [w.LPCWSTR]
u.DeleteAppContainerProfile.restype = c.c_long
a.FreeSid.argtypes = [c.c_void_p]
a.FreeSid.restype = c.c_void_p
k.InitializeProcThreadAttributeList.argtypes = [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(SIZE)]
k.InitializeProcThreadAttributeList.restype = w.BOOL
k.UpdateProcThreadAttribute.argtypes = [c.c_void_p, w.DWORD, SIZE, c.c_void_p, SIZE, c.c_void_p, c.c_void_p]
k.UpdateProcThreadAttribute.restype = w.BOOL
k.DeleteProcThreadAttributeList.argtypes = [c.c_void_p]
k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD,
                             c.c_void_p, w.LPCWSTR, c.POINTER(StartupInfo), c.POINTER(ProcessInformation)]
k.CreateProcessW.restype = w.BOOL
k.ResumeThread.argtypes = [HANDLE]
k.ResumeThread.restype = w.DWORD
k.WaitForSingleObject.argtypes = [HANDLE, w.DWORD]
k.WaitForSingleObject.restype = w.DWORD
k.GetExitCodeProcess.argtypes = [HANDLE, c.POINTER(w.DWORD)]
k.GetExitCodeProcess.restype = w.BOOL
k.TerminateProcess.argtypes = [HANDLE, w.UINT]
k.CloseHandle.argtypes = [HANDLE]
a.OpenProcessToken.argtypes = [HANDLE, w.DWORD, c.POINTER(HANDLE)]
a.OpenProcessToken.restype = w.BOOL
a.GetTokenInformation.argtypes = [HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)]
a.GetTokenInformation.restype = w.BOOL


def check(ok, operation):
    if not ok:
        raise OSError(c.get_last_error(), operation)


def launch(executable, arguments, sandbox=True, profile=False):
    sid = c.c_void_p()
    name = "GlintProbe." + uuid.uuid4().hex
    profile_created = False
    if profile:
        hr = u.CreateAppContainerProfile(name, name, "Temporary Glint isolation probe", None, 0, c.byref(sid))
        if hr != 0:
            raise OSError(hr & 0xffffffff, "create unique temporary AppContainer profile")
        profile_created = True
    else:
        hr = u.DeriveAppContainerSidFromAppContainerName(name, c.byref(sid))
        if hr != 0:
            raise OSError(hr & 0xffffffff, "derive ephemeral AppContainer SID")
    initialized = False
    proc = ProcessInformation()
    created = False
    try:
        size = SIZE()
        k.InitializeProcThreadAttributeList(None, 1, 0, c.byref(size))
        check(size.value > 0, "size process attribute list")
        storage = c.create_string_buffer(size.value)
        check(k.InitializeProcThreadAttributeList(storage, 1, 0, c.byref(size)), "initialize attributes")
        initialized = True
        security = SecurityCapabilities(sid, None, 0, 0)
        if sandbox:
            check(k.UpdateProcThreadAttribute(storage, 0, 0x00020009, c.byref(security), c.sizeof(security), None, None), "set security capabilities")
        startup = StartupInfoEx()
        startup.startup.cb = c.sizeof(startup)
        startup.attributes = c.cast(storage, c.c_void_p)
        import subprocess
        command = c.create_unicode_buffer(subprocess.list2cmdline([str(executable), *arguments]))
        check(k.CreateProcessW(str(executable), command, None, None, False,
                               0x00080000 | 0x00000004 | 0x08000000,
                               None, str(executable.parent), c.byref(startup.startup), c.byref(proc)),
              "CreateProcessW AppContainer")
        created = True
        token = HANDLE()
        check(a.OpenProcessToken(proc.process, 0x0008, c.byref(token)), "open own child token")
        try:
            is_container = w.DWORD()
            returned = w.DWORD()
            check(a.GetTokenInformation(token, 29, c.byref(is_container), c.sizeof(is_container), c.byref(returned)), "read TokenIsAppContainer")
        finally:
            k.CloseHandle(token)
        check(k.ResumeThread(proc.thread) != 0xffffffff, "resume own child")
        waited = k.WaitForSingleObject(proc.process, 15000)
        if waited != 0:
            raise OSError(c.get_last_error(), f"child wait failed or timed out: {waited}")
        code = w.DWORD()
        check(k.GetExitCodeProcess(proc.process, c.byref(code)), "read child exit")
        return is_container.value, code.value
    finally:
        if created:
            if k.WaitForSingleObject(proc.process, 0) != 0:
                k.TerminateProcess(proc.process, 1)
                k.WaitForSingleObject(proc.process, 5000)
            k.CloseHandle(proc.thread)
            k.CloseHandle(proc.process)
        if initialized:
            k.DeleteProcThreadAttributeList(storage)
        a.FreeSid(sid)
        if profile_created:
            hr = u.DeleteAppContainerProfile(name)
            if hr != 0:
                raise OSError(hr & 0xffffffff, f"delete owned AppContainer profile {name}")
            print("temporary AppContainer profile deleted", flush=True)


def main():
    system = pathlib.Path(os.environ["SystemRoot"]) / "System32"
    cmd = system / "cmd.exe"
    curl = system / "curl.exe"
    with tempfile.TemporaryDirectory(prefix="glint-appcontainer-probe-") as tmp:
        fixture = pathlib.Path(tmp) / "private-sentinel.txt"
        fixture.write_text("glint-owned-sentinel", encoding="ascii")
        assert fixture.read_text(encoding="ascii") == "glint-owned-sentinel"
        print("host fixture read: allowed", flush=True)
        assert cmd.is_file(), f"control executable missing: {cmd}"
        identity, code = launch(cmd, ["/d", "/c", "exit 42"], sandbox=False)
        print(f"unrestricted control identity={identity}, exit={code}", flush=True)
        if (identity, code) != (0, 42):
            raise RuntimeError("unrestricted control did not execute as expected")
        try:
            identity, code = launch(cmd, ["/d", "/c", "exit 42"])
        except OSError as error:
            print(f"profile-free AppContainer startup failed: {error}; retrying with owned profile", flush=True)
            identity, code = launch(cmd, ["/d", "/c", "exit 42"], profile=True)
        print(f"AppContainer identity={identity}, control exit={code}", flush=True)
        if (identity, code) != (1, 42):
            raise RuntimeError("AppContainer control did not execute as expected")
        assert curl.is_file(), f"probe executable missing: {curl}"
        file_args = ["--output", "NUL", fixture.as_uri()]
        identity, code = launch(curl, file_args, sandbox=False)
        print(f"unrestricted fixture read: identity={identity}, curl exit={code}", flush=True)
        if (identity, code) != (0, 0):
            raise RuntimeError("unrestricted file control failed")
        identity, code = launch(curl, file_args, profile=True)
        print(f"AppContainer fixture read: identity={identity}, curl exit={code} (37=file access failed)", flush=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(2)
            port = listener.getsockname()[1]
            # The success path is proved on the same listener before the sandbox attempt.
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                conn, _ = listener.accept()
                conn.close()
            print("host loopback: allowed", flush=True)
            assert curl.is_file(), f"network probe executable missing: {curl}"
            identity2, netcode = launch(curl, ["--noproxy", "*", "--connect-timeout", "2", "--max-time", "3", f"http://127.0.0.1:{port}/"], profile=True)
            print(f"AppContainer loopback: identity={identity2}, curl exit={netcode} (7=connect failed, 28=timeout)", flush=True)
            try:
                conn, _ = listener.accept()
                conn.close()
                observed = True
            except socket.timeout:
                observed = False
            print(f"loopback listener observed sandbox connection: {observed}", flush=True)
        if identity != 1 or code != 37 or identity2 != 1 or netcode not in (7, 28) or observed:
            raise RuntimeError("isolation expectation not demonstrated")
        print("Probe only: no output grants, renderer, descendants, remote network or production integration tested.")


if __name__ == "__main__":
    main()
