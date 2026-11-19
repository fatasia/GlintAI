"""Tests for the disposable, non-service encoder broker prototype."""
import concurrent.futures
import importlib.util
import ipaddress
import socket
import json
import os
import pathlib
import secrets
import sys
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import zlib

spec = importlib.util.spec_from_file_location('broker', pathlib.Path(__file__).with_name('appcontainer-broker-prototype.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    pixels = (b'\x00' + b'\xf0\x14\x50' * 16) * 16
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


class ContractTests(unittest.TestCase):
    token = b'a' * broker.IPC_TOKEN_BYTES

    def setUp(self):
        self.now = 0
        self.job = broker.SingleJobContract(self.token, clock=lambda: self.now)

    def send(self, op, sequence, body=b'', version=broker.IPC_VERSION, length=None):
        header = broker.IPC_HEADER.pack(version, op, sequence, len(body) if length is None else length)
        return self.job.accept(header, body)

    def begin(self, frames=2):
        self.assertEqual(self.send(broker.IPC_AUTH, 0, self.token), 'authenticated')
        self.assertEqual(self.send(broker.IPC_BEGIN, 0, struct.pack('!II', frames, 4)), 'ready')

    def test_single_job_and_frame_backpressure(self):
        self.begin()
        for i in range(2):
            self.assertEqual(self.send(broker.IPC_FRAME, i, png()), 'frame')
            self.job.acknowledge_frame()
        self.assertEqual(self.send(broker.IPC_FINISH, 2), 'finished')
        with self.assertRaises(broker.ContractError):
            self.send(broker.IPC_AUTH, 0, self.token)

    def test_unauthenticated_and_malformed_are_terminal(self):
        for op, body, version, length in [
            (broker.IPC_AUTH, b'b' * 32, 1, None),
            (broker.IPC_BEGIN, struct.pack('!II', 1, 4), 1, None),
            (broker.IPC_AUTH, self.token, 2, None),
            (broker.IPC_AUTH, self.token, 1, broker.IPC_FRAME_BYTES + 1),
            (broker.IPC_AUTH, self.token, 1, 31),
        ]:
            with self.subTest(op=op, version=version, length=length):
                self.setUp()
                with self.assertRaises(broker.ContractError):
                    self.send(op, 0, body, version, length)
                with self.assertRaises(broker.ContractError):
                    self.send(broker.IPC_AUTH, 0, self.token)

    def test_forbidden_commands_and_bad_frames(self):
        for op, sequence, body in [
            (99, 0, b'cmd.exe'), (broker.IPC_FRAME, 1, png()),
            (broker.IPC_FRAME, 0, b''), (broker.IPC_FRAME, 0, b'x' * (broker.IPC_FRAME_BYTES + 1)),
            (broker.IPC_FINISH, 2, b''),
        ]:
            with self.subTest(op=op, sequence=sequence, size=len(body)):
                self.setUp()
                self.begin()
                with self.assertRaises(broker.ContractError):
                    self.send(op, sequence, body)

    def test_backpressure_timeout_and_limits(self):
        self.begin()
        self.send(broker.IPC_FRAME, 0, png())
        with self.assertRaises(broker.ContractError):
            self.send(broker.IPC_FRAME, 1, png())
        self.setUp()
        self.begin(5)
        for i in range(4):
            self.send(broker.IPC_FRAME, i, b'x' * broker.IPC_FRAME_BYTES)
            self.job.acknowledge_frame()
        with self.assertRaises(broker.ContractError):
            self.send(broker.IPC_FRAME, 4, b'x')
        self.setUp()
        self.begin()
        self.send(broker.IPC_FRAME, 0, png())
        self.now = broker.IPC_DEADLINE_SECONDS
        with self.assertRaises(broker.ContractError):
            self.job.acknowledge_frame()

    def test_begin_bounds(self):
        for frames, fps in [(0, 1), (broker.MAX_FRAMES + 1, 1), (1, 0), (1, 31)]:
            self.setUp()
            self.send(broker.IPC_AUTH, 0, self.token)
            with self.assertRaises(broker.ContractError):
                self.send(broker.IPC_BEGIN, 0, struct.pack('!II', frames, fps))


class PipeTests(unittest.TestCase):
    # One owned subprocess per test; stdin supplies its capability and ACKs,
    # stdout is its private request pipe. It is not an AppContainer worker.
    def exercise(self, behavior):
        program = r'''
import os, struct, sys, time
mode = sys.argv[1]
token = sys.stdin.buffer.read(32)
def send(op, seq, body=b'', length=None):
    packet = struct.pack('!BBII', 1, op, seq, len(body) if length is None else length) + body
    os.write(1, packet)
def ack():
    if os.read(0, 1) != b'\x06': raise RuntimeError('missing ACK')
if mode == 'oversize':
    send(1, 0, length=1048577)
elif mode == 'stall':
    os.write(1, b'\x01')
    time.sleep(5)
elif mode == 'body-stall':
    send(1, 0, b'x', length=32)
    time.sleep(5)
elif mode == 'closed':
    pass
else:
    send(1, 0, b'x'*32 if mode == 'bad-token' else token)
    if mode != 'bad-token':
        ack(); send(2, 0, struct.pack('!II', 1, 4)); ack()
        send(3, 0, b'frame'); ack(); send(4, 1); ack()
'''
        with tempfile.TemporaryDirectory(prefix='glint-owned-ipc-') as tmp:
            env = {'SystemRoot': os.environ['SystemRoot'], 'TEMP': tmp, 'TMP': tmp,
                   'LOCALAPPDATA': tmp}
            child = subprocess.Popen([sys.executable, '-B', '-c', program, behavior],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                cwd=tmp, env=env)
            token = secrets.token_bytes(32)
            old_deadline = broker.IPC_DEADLINE_SECONDS
            broker.IPC_DEADLINE_SECONDS = 1
            frames = []
            try:
                child.stdin.write(token)
                child.stdin.flush()
                if behavior == 'ok':
                    count = broker.serve_pipe(child.stdout.fileno(), child.stdin.fileno(), token,
                                              lambda seq, data: frames.append((seq, data)))
                    self.assertEqual((count, frames), (1, [(0, b'frame')]))
                    self.assertEqual(child.wait(timeout=3), 0)
                else:
                    with self.assertRaises(broker.ContractError):
                        broker.serve_pipe(child.stdout.fileno(), child.stdin.fileno(), token,
                                          lambda seq, data: frames.append((seq, data)))
                    self.assertEqual(frames, [])
            finally:
                broker.IPC_DEADLINE_SECONDS = old_deadline
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
                child.stdin.close()
                child.stdout.close()

    def test_real_pipe_success(self):
        self.exercise('ok')

    def test_real_pipe_failure_paths(self):
        for behavior in ('oversize', 'stall', 'body-stall', 'closed', 'bad-token'):
            with self.subTest(behavior=behavior):
                self.exercise(behavior)


class BrokerTests(unittest.TestCase):
    def test_unlisted_inheritable_file_handle_is_not_available_to_worker(self):
        # Positive control proves the fixture handle is genuinely inheritable.
        # Only a newly created sentinel file and our own child processes are used.
        powershell = pathlib.Path(os.environ['SystemRoot']) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'
        with tempfile.TemporaryDirectory(prefix='glint-owned-handle-isolation-') as tmp:
            root = pathlib.Path(tmp)
            secret_file = root / 'sentinel'
            secret_file.write_bytes(b'GLINT_OWNED_HANDLE_SENTINEL')
            source, output = root / 'input', root / 'output'
            source.write_bytes(b'')
            output.write_bytes(b'')
            handle = broker.worker.p.open_inheritable(secret_file, 0x80000000)
            command = (
                '$ErrorActionPreference="Stop"; '
                f'$h=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]{handle},$false); '
                'try { $s=New-Object System.IO.FileStream($h,[System.IO.FileAccess]::Read); '
                '$b=New-Object byte[] 27; $n=$s.Read($b,0,$b.Length); '
                'if ([Text.Encoding]::ASCII.GetString($b,0,$n) -eq "GLINT_OWNED_HANDLE_SENTINEL") '
                '{ [Console]::Out.WriteLine("SENTINEL_READ") } '
                'else { [Console]::Out.WriteLine("SENTINEL_NOT_READ") } } '
                'catch { [Console]::Out.WriteLine("SENTINEL_NOT_READ") }'
            )
            env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root),
                   'TEMP': str(root), 'TMP': str(root)}
            try:
                control = subprocess.run([str(powershell), '-NoLogo', '-NoProfile', '-NonInteractive',
                                          '-Command', command], close_fds=False, cwd=root, env=env,
                                         capture_output=True, text=True, timeout=15, check=True)
                self.assertEqual(control.stdout.strip(), 'SENTINEL_READ', 'positive control must read inherited handle')
                # Both processes share the file object; rewind after the positive control.
                kernel = broker.worker.p.k
                kernel.SetFilePointerEx.argtypes = [broker.ctypes.c_void_p, broker.ctypes.c_longlong,
                                                    broker.ctypes.c_void_p, broker.ctypes.c_uint32]
                kernel.SetFilePointerEx.restype = broker.ctypes.c_int
                broker.worker.p.p.check(kernel.SetFilePointerEx(handle, 0, None, 0), 'rewind owned sentinel')
                code, _ = broker.worker.p.run(command, source, output, environment=env)
                self.assertEqual(code, 0)
                self.assertEqual(output.read_text(encoding='ascii').strip(), 'SENTINEL_NOT_READ')
                self.assertEqual(secret_file.read_bytes(), b'GLINT_OWNED_HANDLE_SENTINEL')
            finally:
                broker.worker.p.k.CloseHandle(handle)

    def test_cancel_one_of_two_owned_jobs(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node unavailable')
        barrier = threading.Barrier(2, timeout=15)
        cancelled = threading.Event()
        with tempfile.TemporaryDirectory(prefix='glint-owned-parallel-') as tmp:
            root = pathlib.Path(tmp)

            def run_job(name):
                owned = root / name
                owned.mkdir()
                stage, work = owned / 'stage', owned / 'work'
                script, marker = stage / 'worker.cjs', work / 'completed'

                def prepare(sid):
                    broker.worker.create_owned_directory(stage, sid)
                    broker.worker.create_owned_directory(work, sid, writable=True)
                    script.write_text("const fs=require('fs'); process.stdout.write('R'); "
                        "process.stdin.once('data',()=>{fs.writeFileSync(process.env.MARKER,'done'); "
                        "process.stdout.write('D',()=>process.exit(0));});", encoding='utf8')

                env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(owned),
                       'TEMP': str(work), 'TMP': str(work), 'PATH': str(stage), 'MARKER': str(marker)}

                def exchange(read_fd, write_fd, process, deadline):
                    kernel = broker.ctypes.WinDLL('kernel32', use_last_error=True)
                    kernel.PeekNamedPipe.argtypes = [broker.ctypes.c_void_p, broker.ctypes.c_void_p,
                        broker.ctypes.c_uint32, broker.ctypes.c_void_p,
                        broker.ctypes.POINTER(broker.ctypes.c_uint32), broker.ctypes.c_void_p]
                    kernel.PeekNamedPipe.restype = broker.ctypes.c_int
                    def read_byte():
                        handle = broker.msvcrt.get_osfhandle(read_fd)
                        while time.monotonic() < deadline:
                            available = broker.ctypes.c_uint32()
                            if not kernel.PeekNamedPipe(handle, None, 0, None, broker.ctypes.byref(available), None):
                                raise RuntimeError('worker pipe closed before response')
                            if available.value:
                                return os.read(read_fd, 1)
                            time.sleep(0.01)
                        raise TimeoutError('worker response deadline exceeded')
                    self.assertEqual(read_byte(), b'R')
                    barrier.wait()
                    if name == 'cancelled':
                        raise RuntimeError('deliberate cancellation')
                    if not cancelled.wait(timeout=10):
                        raise TimeoutError('cancelled job did not finish cleanup')
                    self.assertEqual(os.write(write_fd, b'go'), 2)
                    self.assertEqual(read_byte(), b'D')

                try:
                    result = broker.worker.p.run(None, owned / 'unused', None, executable=node,
                        arguments=['--preserve-symlinks', '--preserve-symlinks-main', str(script)],
                        environment=env, prepare_profile=prepare, pipe_handler=exchange, deadline_ms=30000)
                    return result[0]
                finally:
                    if name == 'cancelled':
                        cancelled.set()

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                victim = executor.submit(run_job, 'cancelled')
                survivor = executor.submit(run_job, 'survivor')
                with self.assertRaisesRegex(RuntimeError, 'deliberate cancellation'):
                    victim.result(timeout=40)
                self.assertEqual(survivor.result(timeout=40), 0)
            self.assertFalse((root / 'cancelled' / 'work' / 'completed').exists())
            self.assertEqual((root / 'survivor' / 'work' / 'completed').read_text(), 'done')

    def test_cancel_owned_running_worker(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node unavailable')
        with tempfile.TemporaryDirectory(prefix='glint-owned-cancel-') as tmp:
            root = pathlib.Path(tmp)
            stage, work = root / 'stage', root / 'work'
            script = stage / 'worker.cjs'
            marker = work / 'late-write'
            def prepare(sid):
                broker.worker.create_owned_directory(stage, sid)
                broker.worker.create_owned_directory(work, sid, writable=True)
                script.write_text("process.stdout.write('R'); setTimeout(()=>require('fs').writeFileSync(process.env.MARKER,'late'), 2000);", encoding='utf8')
            env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root),
                   'TEMP': str(work), 'TMP': str(work), 'PATH': str(stage), 'MARKER': str(marker)}
            def cancel(read_fd, write_fd, process, deadline):
                self.assertEqual(os.read(read_fd, 1), b'R')
                raise RuntimeError('test cancellation')
            with self.assertRaisesRegex(RuntimeError, 'test cancellation'):
                broker.worker.p.run(None, root / 'unused', None, executable=node,
                    arguments=['--preserve-symlinks', '--preserve-symlinks-main', str(script)],
                    environment=env, prepare_profile=prepare, pipe_handler=cancel)
            self.assertFalse(marker.exists())

    def test_confined_node_worker_network_boundary(self):
        """Actual Node sockets against only listeners owned by this test, not Internet egress."""
        node = shutil.which('node')
        if not node:
            self.fail('node is required')
        addresses = {entry[4][0] for entry in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
        candidates = sorted(address for address in addresses if ipaddress.ip_address(address).is_private
                            and not ipaddress.ip_address(address).is_loopback)
        if not candidates:
            self.skipTest('no local non-loopback IPv4 interface available')
        listeners = []
        try:
            for address in ('127.0.0.1', candidates[0]):
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listeners.append(listener)
                listener.bind((address, 0))
                listener.listen(2)
                listener.settimeout(1)
                # Prove the same address and listener are reachable by the parent.
                with socket.create_connection(listener.getsockname(), timeout=2):
                    connection, _ = listener.accept()
                    connection.close()
            with tempfile.TemporaryDirectory(prefix='glint-owned-node-network-') as tmp:
                root = pathlib.Path(tmp)
                stage, work = root / 'stage', root / 'work'
                source, output, script = root / 'input', root / 'output', stage / 'network.cjs'
                source.write_bytes(b'')
                output.write_bytes(b'')
                def prepare(sid):
                    broker.worker.create_owned_directory(stage, sid)
                    broker.worker.create_owned_directory(work, sid, writable=True)
                    script.write_text(r'''
const net = require('node:net');
const targets = JSON.parse(process.env.GLINT_TEST_TARGETS);
async function attempt(target) {
  return new Promise(resolve => {
    const s = net.createConnection(target);
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve({connected:true}); });
    s.once('error', e => { s.destroy(); resolve({connected:false, error:e.code}); });
    s.once('timeout', () => { s.destroy(); resolve({connected:false, error:'TIMEOUT'}); });
  });
}
(async () => { for (const target of targets) console.log(JSON.stringify(await attempt(target))); })()
  .catch(e => { console.error(e); process.exitCode = 1; });
''', encoding='utf8')
                targets = [{'host': listener.getsockname()[0], 'port': listener.getsockname()[1]}
                           for listener in listeners]
                env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root),
                       'TEMP': str(work), 'TMP': str(work), 'PATH': str(stage),
                       'GLINT_TEST_TARGETS': json.dumps(targets)}
                code, _ = broker.worker.p.run(None, source, output, executable=node,
                    arguments=['--preserve-symlinks', '--preserve-symlinks-main', str(script)],
                    environment=env, prepare_profile=prepare, deadline_ms=15000,
                    memory_limit=512 * 1024 * 1024)
                self.assertEqual(code, 0)
                results = [json.loads(line) for line in output.read_text(encoding='utf8').splitlines()]
                self.assertEqual(len(results), 2, 'worker must report both socket attempts')
                for result in results:
                    self.assertEqual(result.get('connected'), False, result)
                    self.assertIn(result.get('error'), ('EACCES', 'EPERM', 'ECONNREFUSED', 'ETIMEDOUT', 'TIMEOUT'), result)
                for listener in listeners:
                    with self.assertRaises(socket.timeout, msg='owned listener received worker connection'):
                        connection, _ = listener.accept()
                        connection.close()
                print('Node AppContainer: no connection observed on controlled loopback and non-loopback listeners:', results)
        finally:
            for listener in listeners:
                listener.close()

    def test_controlled_nonloopback_network(self):
        addresses = {entry[4][0] for entry in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
        candidates = sorted(address for address in addresses if ipaddress.ip_address(address).is_private
                            and not ipaddress.ip_address(address).is_loopback)
        if not candidates:
            self.skipTest('no owned local non-loopback IPv4 interface available')
        address = candidates[0]
        curl = pathlib.Path(os.environ['SystemRoot']) / 'System32' / 'curl.exe'
        with socket.socket() as listener:
            listener.bind((address, 0))
            listener.listen(2)
            listener.settimeout(2)
            port = listener.getsockname()[1]
            with socket.create_connection((address, port), timeout=2):
                connection, _ = listener.accept()
                connection.close()
            identity, code = broker.worker.p.p.launch(curl,
                ['--noproxy', '*', '--connect-timeout', '2', '--max-time', '3', f'http://{address}:{port}/'], profile=True)
            try:
                connection, _ = listener.accept()
                connection.close()
                observed = True
            except socket.timeout:
                observed = False
            self.assertEqual(identity, 1)
            self.assertIn(code, (7, 28))
            self.assertFalse(observed, 'owned listener received an AppContainer connection')

    def test_rejected_requests(self):
        good = {'op': 'encode_png_test', 'frames': 4, 'fps': 4}
        bad = [None, {}, {**good, 'command': 'cmd.exe'}, {**good, 'output': 'C:\\test'},
               {**good, 'op': 'spawn'}, {**good, 'frames': True}, {**good, 'frames': 0},
               {**good, 'frames': 31}, {**good, 'fps': 0}, {**good, 'fps': 31}]
        for request in bad:
            with self.subTest(request=request), self.assertRaises(ValueError):
                broker.validate_request(request, png())
        for data in (b'', b'x' * (broker.MAX_INPUT + 1), 'not bytes'):
            with self.assertRaises(ValueError):
                broker.validate_request(good, data)

    def test_runtime_output_limit_terminates_encoder(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            self.fail('ffmpeg is required')
        with self.assertRaisesRegex(RuntimeError, 'runtime limit'):
            broker.encode({'op': 'encode_png_test', 'frames': 4, 'fps': 4}, png() * 4, ffmpeg, output_limit=32)

    def test_confined_worker_to_broker_to_confined_encoder(self):
        node, ffmpeg, ffprobe = map(shutil.which, ('node', 'ffmpeg', 'ffprobe'))
        if not all((node, ffmpeg, ffprobe)):
            self.fail('node, ffmpeg and ffprobe are required')
        token = secrets.token_bytes(32)
        with tempfile.TemporaryDirectory(prefix='glint-owned-chain-') as tmp:
            root = pathlib.Path(tmp)
            stage, work = root / 'stage', root / 'work'
            source, output = root / 'unused-input', root / 'unused-output'
            script = stage / 'worker.cjs'
            program = r'''
const fs=require('fs');
function read(n) { let b=Buffer.alloc(n), p=0; while(p<n) { let k=fs.readSync(0,b,p,n-p,null); if(!k) throw Error('EOF'); p+=k; } return b; }
function send(op,seq,body=Buffer.alloc(0)) { let h=Buffer.alloc(10); h[0]=1; h[1]=op; h.writeUInt32BE(seq,2); h.writeUInt32BE(body.length,6); fs.writeSync(1,Buffer.concat([h,body])); if(read(1)[0]!==6) throw Error('ACK'); }
const {Resvg}=require('@resvg/resvg-js');
let token=read(32); send(1,0,token); let begin=Buffer.alloc(8); begin.writeUInt32BE(4,0); begin.writeUInt32BE(4,4); send(2,0,begin);
for(let i=0;i<4;i++) { const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="rgb(${i*60},20,80)"/></svg>`; send(3,i,new Resvg(svg).render().asPng()); } send(4,4);
'''
            def prepare(sid):
                broker.worker.create_owned_directory(stage, sid)
                broker.worker.create_owned_directory(work, sid, writable=True)
                script.write_text(program, encoding='utf8')
                store = broker.worker.ROOT / 'node_modules' / '.pnpm'
                package = stage / 'node_modules' / '@resvg'
                package.mkdir(parents=True)
                for name, version in [('resvg-js', '@resvg+resvg-js@2.6.2'), ('resvg-js-win32-x64-msvc', '@resvg+resvg-js-win32-x64-msvc@2.6.2')]:
                    shutil.copytree(store / version / 'node_modules' / '@resvg' / name, package / name, symlinks=False)
            env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root),
                   'TEMP': str(work), 'TMP': str(work), 'PATH': str(stage)}
            frames, settings = [], []
            def exchange(read_fd, write_fd, process, deadline):
                os.write(write_fd, token)
                count = broker.serve_pipe(read_fd, write_fd, token,
                    lambda seq, data: frames.append(data), lambda n, fps: settings.append((n, fps)))
                self.assertEqual(count, 4)
            code, _ = broker.worker.p.run(None, source, output, executable=node,
                arguments=['--preserve-symlinks', '--preserve-symlinks-main', str(script)], environment=env, prepare_profile=prepare,
                pipe_handler=exchange, deadline_ms=15000, memory_limit=512*1024*1024)
            self.assertEqual(code, 0)
            self.assertEqual(settings, [(4, 4)])
            self.assertEqual(len(set(frames)), 4, 'worker must actually render distinct frames')
            result = broker.encode({'op':'encode_png_test', 'frames':settings[0][0], 'fps':settings[0][1]}, b''.join(frames), ffmpeg)
            target = root / 'verified.mp4'
            target.write_bytes(result)
            probe = subprocess.run([ffprobe, '-v', 'error', '-count_frames', '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', str(target)],
                capture_output=True, text=True, timeout=15, check=True)
            self.assertEqual(json.loads(probe.stdout)['streams'][0],
                {'codec_name':'mpeg4', 'width':16, 'height':16, 'nb_read_frames':'4'})

    def test_confined_encoder_real_png_and_invalid_payload(self):
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            self.fail('ffmpeg and ffprobe are required')
        request = {'op': 'encode_png_test', 'frames': 4, 'fps': 4}
        result = broker.encode(request, png() * 4, ffmpeg)
        with tempfile.TemporaryDirectory(prefix='glint-owned-broker-test-') as tmp:
            target = pathlib.Path(tmp) / 'result.mp4'
            target.write_bytes(result)
            proc = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0',
                '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
                '-of', 'json', str(target)], capture_output=True, text=True, timeout=15, check=True)
            stream = json.loads(proc.stdout)['streams'][0]
            self.assertEqual({key: stream[key] for key in ('codec_name', 'width', 'height', 'nb_read_frames')},
                {'codec_name': 'mpeg4', 'width': 16, 'height': 16, 'nb_read_frames': '4'})
        with self.assertRaises(RuntimeError):
            broker.encode(request, b'not a png', ffmpeg)


class ConfinedRenderOpTests(unittest.TestCase):
    @staticmethod
    def sized_png(width, height, color):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
        pixels = (b'\x00' + bytes(color) * width) * height
        return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))

    @classmethod
    def clip_frames(cls, count, shade=0):
        return [cls.sized_png(960, 540, (min(255, shade + index * 18), 20, 80)) for index in range(count)]

    def probe(self, blob):
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            self.fail('ffmpeg and ffprobe are required')
        with tempfile.TemporaryDirectory(prefix='glint-owned-op-test-') as tmp:
            target = pathlib.Path(tmp) / 'result.mp4'
            target.write_bytes(blob)
            proc = subprocess.run([ffprobe, '-v', 'error', '-count_frames', '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
                '-show_entries', 'format=duration', '-of', 'json', str(target)],
                capture_output=True, text=True, timeout=15, check=True)
        return json.loads(proc.stdout)

    def test_encode_png_clip_verified(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            self.fail('ffmpeg is required')
        blob = broker.encode_png_clip(self.clip_frames(12), 24, ffmpeg)
        stream = self.probe(blob)['streams'][0]
        self.assertEqual({key: stream[key] for key in ('codec_name', 'width', 'height', 'nb_read_frames')},
            {'codec_name': 'h264', 'width': 960, 'height': 540, 'nb_read_frames': '12'})

    def test_encode_png_clip_output_quota_terminates_encoder(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            self.fail('ffmpeg is required')
        with self.assertRaisesRegex(RuntimeError, 'runtime limit'):
            broker.encode_png_clip(self.clip_frames(12), 24, ffmpeg, output_limit=1024)

    def test_encode_png_clip_rejects_bad_payload(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            self.fail('ffmpeg is required')
        with self.assertRaises(RuntimeError):
            broker.encode_png_clip([b'not a png'], 24, ffmpeg)

    def test_encode_png_clip_bounds(self):
        ffmpeg = shutil.which('ffmpeg')
        frames = self.clip_frames(2)
        oversized = [b'x' * (broker.CLIP_FRAME_LIMIT + 1)]
        for kwargs in ({'fps': 0}, {'fps': 31}, {'fps': True}, {'crf': 23}, {'preset': 'fast'}, {'output_limit': 0}):
            with self.subTest(**kwargs), self.assertRaises(ValueError):
                broker.encode_png_clip(frames, **{'fps': 24, **kwargs}, ffmpeg=ffmpeg)
        with self.assertRaises(ValueError):
            broker.encode_png_clip([], 24, ffmpeg)
        with self.assertRaises(ValueError):
            broker.encode_png_clip(oversized, 24, ffmpeg)

    def test_concat_clips_verified(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            self.fail('ffmpeg is required')
        first = broker.encode_png_clip(self.clip_frames(6, shade=0), 24, ffmpeg)
        second = broker.encode_png_clip(self.clip_frames(6, shade=120), 24, ffmpeg)
        container = broker.concat_clips([first, second], 24, 12, ffmpeg)
        probed = self.probe(container)
        stream = probed['streams'][0]
        self.assertEqual({key: stream[key] for key in ('codec_name', 'width', 'height', 'nb_read_frames')},
            {'codec_name': 'h264', 'width': 960, 'height': 540, 'nb_read_frames': '12'})
        self.assertAlmostEqual(float(probed['format']['duration']), 0.5, delta=0.1)

    def test_concat_bounds(self):
        ffmpeg = shutil.which('ffmpeg')
        clips = [b'c' * 16]
        with self.assertRaises(ValueError):
            broker.concat_clips([], 24, 12, ffmpeg)
        with self.assertRaises(ValueError):
            broker.concat_clips([b'x' * (broker.CLIP_FRAME_LIMIT + 1)], 24, 12, ffmpeg)
        with self.assertRaises(ValueError):
            broker.concat_clips(clips, 24, 0, ffmpeg)
        with self.assertRaises(ValueError):
            broker.concat_clips(clips, 31, 12, ffmpeg)


if __name__ == '__main__':
    unittest.main(verbosity=2)
