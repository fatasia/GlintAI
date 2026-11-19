"""Disposable Windows capability-handle integration experiment, not a sandbox.

Only self-created temporary fixtures and child processes are touched. No ACLs are
changed; Web rendering must remain disabled. Run with Python on Windows.
"""
import ctypes as c
from ctypes import wintypes as w
import importlib.util
import msvcrt
import os
import pathlib
import subprocess
import tempfile
import time
import uuid

if os.name != "nt":
    raise SystemExit("Windows only")

spec = importlib.util.spec_from_file_location("appcontainer_probe", pathlib.Path(__file__).with_name("appcontainer-probe.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
k, a, u = p.k, p.a, p.u
H = w.HANDLE

class SecurityAttributes(c.Structure):
    _fields_ = [("length", w.DWORD), ("descriptor", c.c_void_p), ("inherit", w.BOOL)]

class IoCounters(c.Structure):
    _fields_ = [(name, c.c_ulonglong) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

class BasicLimits(c.Structure):
    _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong), ("flags", w.DWORD),
                ("min_working", c.c_size_t), ("max_working", c.c_size_t), ("active", w.DWORD),
                ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]

class ExtendedLimits(c.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IoCounters), ("process_memory", c.c_size_t),
                ("job_memory", c.c_size_t), ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]

k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.POINTER(SecurityAttributes), w.DWORD, w.DWORD, H]
k.CreateFileW.restype = H
k.CreatePipe.argtypes = [c.POINTER(H), c.POINTER(H), c.POINTER(SecurityAttributes), w.DWORD]
k.CreatePipe.restype = w.BOOL
k.SetHandleInformation.argtypes = [H, w.DWORD, w.DWORD]
k.SetHandleInformation.restype = w.BOOL
k.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
k.CreateJobObjectW.restype = H
k.SetInformationJobObject.argtypes = [H, c.c_int, c.c_void_p, w.DWORD]
k.SetInformationJobObject.restype = w.BOOL
k.AssignProcessToJobObject.argtypes = [H, H]
k.AssignProcessToJobObject.restype = w.BOOL
k.IsProcessInJob.argtypes = [H, H, c.POINTER(w.BOOL)]
k.IsProcessInJob.restype = w.BOOL
k.ResumeThread.restype = w.DWORD
k.TerminateProcess.restype = w.BOOL

INVALID = c.c_void_p(-1).value
WAIT_TIMEOUT = 258
MEMORY_LIMIT = 128 * 1024 * 1024


def open_inheritable(path, access):
    attributes = SecurityAttributes(c.sizeof(SecurityAttributes), None, True)
    handle = k.CreateFileW(str(path), access, 3, c.byref(attributes), 3, 0, None)
    if handle == INVALID:
        raise OSError(c.get_last_error(), f"open owned fixture {path}")
    return handle


def environment_block(values):
    """Construct a Unicode environment block without inheriting host variables."""
    seen = set()
    for key, value in values.items():
        if not isinstance(key, str) or not isinstance(value, str) or not key or "=" in key or "\0" in key or "\0" in value or key.upper() in seen:
            raise ValueError("invalid or duplicate Windows environment variable")
        seen.add(key.upper())
    entries = [f"{key}={values[key]}" for key in sorted(values, key=str.upper)]
    return c.create_unicode_buffer("\0".join(entries) + "\0\0")


def run(cmd, input_path, output_path, cpu_ms=10000, deadline_ms=15000, inject_assign_failure=False,
        environment=None, executable=None, arguments=None, prepare_profile=None, memory_limit=MEMORY_LIMIT,
        pipe_handler=None, output_handler=None, broker_handler=None):
    """Launch one suspended AppContainer process with inherited handle capabilities.

    broker_handler(request_fd, response_fd, media_fd, process, deadline) runs the
    three-pipe broker layout: stdin carries requests plus the broker downlink,
    stdout carries responses, and the stderr slot is repurposed as the raw media
    uplink. Only the two standard pipes plus that uplink are inherited.
    """
    handles = []
    parent_fds = []
    sid = c.c_void_p()
    name = "GlintHandleProbe." + uuid.uuid4().hex
    profile = False
    initialized = False
    created = False
    proc = p.ProcessInformation()
    job = None
    start = time.monotonic()
    try:
        if output_handler is not None:
            handles.append(open_inheritable(input_path, 0x80000000))
            reader, writer = H(), H()
            attributes = SecurityAttributes(c.sizeof(SecurityAttributes), None, True)
            p.check(k.CreatePipe(c.byref(reader), c.byref(writer), c.byref(attributes), 0), 'create output pipe')
            handles.extend((writer.value, reader.value))
            p.check(k.SetHandleInformation(reader, 1, 0), 'protect parent pipe end')
            child_handles = handles[:2]
            parent_fds.append(msvcrt.open_osfhandle(handles[2], os.O_RDONLY | os.O_BINARY))
            handles[2] = None
        elif broker_handler is not None:
            # stdin carries requests, stdout responses, stderr slot = media uplink
            # (the child holds the WRITE end of every std handle).
            for child_reads in (True, False, False):
                reader, writer = H(), H()
                attributes = SecurityAttributes(c.sizeof(SecurityAttributes), None, True)
                p.check(k.CreatePipe(c.byref(reader), c.byref(writer), c.byref(attributes), 0), "create broker pipe")
                child_end, parent_end = (reader.value, writer.value) if child_reads else (writer.value, reader.value)
                handles.extend((child_end, parent_end))
                p.check(k.SetHandleInformation(parent_end, 1, 0), "protect parent pipe end")
            child_handles = [handles[0], handles[2], handles[4]]
            for index, flags in ((1, os.O_WRONLY), (3, os.O_RDONLY), (5, os.O_RDONLY)):
                fd = msvcrt.open_osfhandle(handles[index], flags | os.O_BINARY)
                parent_fds.append(fd)
                handles[index] = None  # descriptor now owns the handle
        elif pipe_handler is None:
            for path, access in ((input_path, 0x80000000), (output_path, 0x40000000)):
                handles.append(open_inheritable(path, access))
        else:
            attributes = SecurityAttributes(c.sizeof(SecurityAttributes), None, True)
            # The child gets only stdin-read and stdout-write; parent ends are never inheritable.
            for child_reads in (True, False):
                reader, writer = H(), H()
                p.check(k.CreatePipe(c.byref(reader), c.byref(writer), c.byref(attributes), 0), 'create anonymous pipe')
                child_end, parent_end = (reader.value, writer.value) if child_reads else (writer.value, reader.value)
                handles.extend((child_end, parent_end))
                p.check(k.SetHandleInformation(parent_end, 1, 0), 'protect parent pipe end')
            child_handles = [handles[0], handles[2]]
            for index, flags in ((1, os.O_WRONLY), (3, os.O_RDONLY)):
                fd = msvcrt.open_osfhandle(handles[index], flags | os.O_BINARY)
                parent_fds.append(fd)
                handles[index] = None  # descriptor now owns the handle
        hr = u.CreateAppContainerProfile(name, name, "Temporary capability probe", None, 0, c.byref(sid))
        if hr != 0:
            raise OSError(hr & 0xffffffff, "create owned temporary profile")
        profile = True
        if prepare_profile is not None:
            prepare_profile(sid)
        job = k.CreateJobObjectW(None, None)
        p.check(job, "create job")
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000 | 0x200 | 0x4  # kill-on-close, job memory, job user time
        limits.basic.job_time = cpu_ms * 10000
        limits.job_memory = memory_limit
        p.check(k.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)), "set job limits")
        size = p.SIZE()
        k.InitializeProcThreadAttributeList(None, 2, 0, c.byref(size))
        p.check(size.value, "size attribute list")
        storage = c.create_string_buffer(size.value)
        p.check(k.InitializeProcThreadAttributeList(storage, 2, 0, c.byref(size)), "initialize attribute list")
        initialized = True
        security = p.SecurityCapabilities(sid, None, 0, 0)
        p.check(k.UpdateProcThreadAttribute(storage, 0, 0x20009, c.byref(security), c.sizeof(security), None, None), "set AppContainer identity")
        child_handles = handles if pipe_handler is None and output_handler is None and broker_handler is None else child_handles
        allowlist = (H * len(child_handles))(*child_handles)
        p.check(k.UpdateProcThreadAttribute(storage, 0, 0x20002, c.byref(allowlist), c.sizeof(allowlist), None, None), "set handle allowlist")
        startup = p.StartupInfoEx()
        startup.startup.cb = c.sizeof(startup)
        startup.startup.flags = 0x100
        startup.startup.stdin, startup.startup.stdout = child_handles[0], child_handles[1]
        startup.startup.stderr = child_handles[2] if broker_handler is not None else child_handles[1]
        startup.attributes = c.cast(storage, c.c_void_p)
        exe = pathlib.Path(executable) if executable else pathlib.Path(os.environ["SystemRoot"]) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        args = arguments if arguments is not None else ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd]
        command = c.create_unicode_buffer(subprocess.list2cmdline([str(exe), *args]))
        # Keep the backing WCHAR array alive through CreateProcessW.  An explicit
        # pointer is required: None means inherit the entire host environment.
        # LOCALAPPDATA is required by AppContainer creation on this host even
        # though no profile data is inherited; give it an owned disposable path.
        env = environment_block(environment if environment is not None else {
            "SystemRoot": os.environ["SystemRoot"], "LOCALAPPDATA": str(input_path.parent)
        })
        p.check(k.CreateProcessW(str(exe), command, None, None, True, 0x80000 | 0x4 | 0x08000000 | 0x400,
                                 c.cast(env, c.c_void_p), str(exe.parent), c.byref(startup.startup), c.byref(proc)), "create suspended child")
        created = True
        token = H()
        p.check(a.OpenProcessToken(proc.process, 8, c.byref(token)), "open child token")
        try:
            identity, returned = w.DWORD(), w.DWORD()
            p.check(a.GetTokenInformation(token, 29, c.byref(identity), c.sizeof(identity), c.byref(returned)), "read child identity")
            if identity.value != 1:
                raise RuntimeError("child is not AppContainer")
        finally:
            k.CloseHandle(token)
        if inject_assign_failure:
            raise RuntimeError("injected assignment failure before resume")
        p.check(k.AssignProcessToJobObject(job, proc.process), "assign suspended child to job")
        in_job = w.BOOL()
        p.check(k.IsProcessInJob(proc.process, job, c.byref(in_job)), "verify job membership")
        if not in_job.value:
            raise RuntimeError("child is not in its job")
        p.check(k.ResumeThread(proc.thread) != 0xffffffff, "resume child")
        if pipe_handler is not None:
            # Closing our copies lets the reader observe the child's EOF.
            for index in (0, 2):
                k.CloseHandle(handles[index])
                handles[index] = None
            pipe_handler(parent_fds[1], parent_fds[0], proc.process, start + deadline_ms / 1000)
        elif output_handler is not None:
            k.CloseHandle(handles[1])
            handles[1] = None
            output_handler(parent_fds[0], proc.process, start + deadline_ms / 1000)
        elif broker_handler is not None:
            # The child ends are ours to close so the parent observes EOF.
            for index in (0, 2, 4):
                k.CloseHandle(handles[index])
                handles[index] = None
            broker_handler(parent_fds[0], parent_fds[1], parent_fds[2], proc.process, start + deadline_ms / 1000)
        remaining = max(0, int((start + deadline_ms / 1000 - time.monotonic()) * 1000))
        waited = k.WaitForSingleObject(proc.process, remaining)
        if waited == WAIT_TIMEOUT:
            raise TimeoutError("owned worker exceeded wall deadline")
        if waited != 0:
            raise OSError(c.get_last_error(), f"child wait failed: {waited}")
        code = w.DWORD()
        p.check(k.GetExitCodeProcess(proc.process, c.byref(code)), "read exit code")
        return code.value, time.monotonic() - start
    finally:
        cleanup_error = None
        if created:
            if k.WaitForSingleObject(proc.process, 0) != 0:
                if not k.TerminateProcess(proc.process, 1):
                    error = c.get_last_error()
                    # Termination can race with normal exit. Closing our job also
                    # triggers kill-on-close before waiting on the owned process.
                    if job:
                        k.CloseHandle(job)
                        job = None
                    if k.WaitForSingleObject(proc.process, 5000) != 0:
                        cleanup_error = OSError(error, "terminate owned child")
                elif k.WaitForSingleObject(proc.process, 5000) != 0:
                    cleanup_error = RuntimeError("owned child did not terminate")
            k.CloseHandle(proc.thread)
            k.CloseHandle(proc.process)
        if job:
            k.CloseHandle(job)
        if initialized:
            k.DeleteProcThreadAttributeList(storage)
        for fd in parent_fds:
            os.close(fd)
        for handle in handles:
            if handle:
                k.CloseHandle(handle)
        if sid.value:
            a.FreeSid(sid)
        if profile:
            hr = u.DeleteAppContainerProfile(name)
            if hr != 0:
                raise OSError(hr & 0xffffffff, f"delete owned profile {name}")
        if cleanup_error:
            raise cleanup_error


def main():
    with tempfile.TemporaryDirectory(prefix="glint-capability-probe-") as tmp:
        for bad in ({"": "x"}, {"x=y": "z"}, {"x": "a\0b"}, {"Path": "a", "PATH": "b"}):
            try:
                environment_block(bad)
                raise AssertionError("invalid environment accepted")
            except ValueError:
                pass
        empty = environment_block({})
        if empty[0] != "\0" or empty[1] != "\0":
            raise AssertionError("empty environment must be double-NUL terminated")
        print("environment block invalid-input and empty-block checks passed")
        root = pathlib.Path(tmp)
        source, output, private = (root / name for name in ("input.txt", "output.txt", "private.txt"))
        source.write_bytes(b"sentinel\r\n")
        private.write_text("private", encoding="ascii")
        output.write_bytes(b"")
        secret_name = "GLINT_PROBE_SECRET_" + uuid.uuid4().hex
        secret_value = uuid.uuid4().hex
        os.environ[secret_name] = secret_value
        try:
            command = f'if ([Environment]::GetEnvironmentVariable("{secret_name}", "Process")) {{ [Console]::Out.WriteLine("SECRET_LEAKED") }} else {{ [Console]::Out.WriteLine("SECRET_ABSENT") }}; [Console]::Out.WriteLine("LOCAL:" + $env:LOCALAPPDATA)'
            code, _ = run(command, source, output)
            result = output.read_text(encoding="ascii", errors="replace")
            if code != 0 or "SECRET_ABSENT" not in result or "SECRET_LEAKED" in result or secret_value in result or f"LOCAL:{root}" not in result:
                raise AssertionError("explicit environment isolation failed")
            print("host secret absent; owned LOCALAPPDATA observed")
        finally:
            del os.environ[secret_name]
        output.write_bytes(b"")
        # Paths are generated here, not supplied by a caller. No user data is used.
        ps = lambda path: str(path).replace("'", "''")
        command = (f'$ErrorActionPreference="Stop"; $inputLine=[Console]::In.ReadLine(); '
                   f'[Console]::Out.WriteLine("READ:$inputLine"); '
                   f'try {{ [Console]::OpenStandardInput().WriteByte(65); [Console]::Out.WriteLine("INPUT_WRITE_ALLOWED") }} catch {{ [Console]::Out.WriteLine("INPUT_WRITE_DENIED") }}; '
                   f'try {{ [Console]::OpenStandardOutput().ReadByte(); [Console]::Out.WriteLine("OUTPUT_READ_ALLOWED") }} catch {{ [Console]::Out.WriteLine("OUTPUT_READ_DENIED") }}; '
                   f'try {{ [IO.File]::ReadAllText(\'{ps(private)}\') | Out-Null; [Console]::Out.WriteLine("PRIVATE_READ_ALLOWED") }} catch {{ [Console]::Out.WriteLine("PRIVATE_READ_DENIED") }}; '
                   f'try {{ [IO.File]::WriteAllText(\'{ps(source)}\',\'change\'); [Console]::Out.WriteLine("PATH_WRITE_ALLOWED") }} catch {{ [Console]::Out.WriteLine("PATH_WRITE_DENIED") }}; '
                   f'try {{ [IO.File]::WriteAllText(\'{ps(root / "sibling.txt")}\',\'change\'); [Console]::Out.WriteLine("SIBLING_WRITE_ALLOWED") }} catch {{ [Console]::Out.WriteLine("SIBLING_WRITE_DENIED") }}; '
                   f'[Console]::Out.WriteLine("OUTPUT_OK")')
        code, _ = run(command, source, output)
        result = output.read_text(encoding="ascii", errors="replace")
        print(f"functional exit={code}\n{result}")
        for expected in ("READ:sentinel", "INPUT_WRITE_DENIED", "OUTPUT_READ_DENIED", "PRIVATE_READ_DENIED", "PATH_WRITE_DENIED", "SIBLING_WRITE_DENIED", "OUTPUT_OK"):
            if expected not in result:
                raise AssertionError(f"missing {expected}: {result!r}")
        if code != 0 or source.read_bytes() != b"sentinel\r\n" or private.read_text() != "private" or (root / "sibling.txt").exists():
            raise AssertionError("fixture integrity or process exit failed")
        output.write_bytes(b"")
        memory_cmd = ('try { $x = New-Object byte[] 536870912; '
                      '[Console]::Out.WriteLine("MEMORY_ALLOWED") } '
                      'catch { [Console]::Out.WriteLine("MEMORY_DENIED") }')
        memory_code, _ = run(memory_cmd, source, output)
        memory_result = output.read_bytes()
        print(f"combined AppContainer+Job memory exit={memory_code}, output={memory_result!r}")
        if memory_code != 0 or b"MEMORY_DENIED" not in memory_result or b"MEMORY_ALLOWED" in memory_result:
            raise AssertionError("large allocation denial was not demonstrated")
        output.write_bytes(b"")
        code, elapsed = run("while ($true) { }", source, output, cpu_ms=1000, deadline_ms=15000)
        print(f"combined AppContainer+Job CPU exit=0x{code:08X}, elapsed={elapsed:.2f}s")
        if code != 0xC0000044:
            raise AssertionError("CPU quota exit was not observed")
        output.write_bytes(b"")
        try:
            run("Start-Sleep -Seconds 30", source, output, deadline_ms=1500)
            raise AssertionError("wall deadline was ignored")
        except TimeoutError:
            print("wall deadline: owned child terminated")
        output.write_bytes(b"")
        try:
            run('[Console]::Out.WriteLine("SHOULD_NOT_RUN")', source, output, inject_assign_failure=True)
            raise AssertionError("injected failure was ignored")
        except RuntimeError as error:
            if "injected assignment failure" not in str(error):
                raise
        if output.read_bytes():
            raise AssertionError("suspended child ran after assignment failure")
        print("assignment failure: child did not execute; fixtures intact")
        print("Prototype only: handle capabilities are not a directory sandbox; no renderer or Web integration.")


if __name__ == "__main__":
    main()
