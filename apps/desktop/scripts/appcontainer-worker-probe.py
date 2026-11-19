"""MOTION-09 disposable dependency-loading experiment; never enables Web rendering.

Only directories created by this process receive explicit DACLs. The bundled
worker is a test artifact, not a production build or a working render sandbox.
The real-render check exits nonzero when blocked or when ffprobe cannot verify it.
"""
import ctypes as c
from ctypes import wintypes as w
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('handle_probe', pathlib.Path(__file__).with_name('appcontainer-handle-probe.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
k, a = p.k, p.a

a.ConvertSidToStringSidW.argtypes = [c.c_void_p, c.POINTER(w.LPWSTR)]
a.ConvertSidToStringSidW.restype = w.BOOL
a.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p]
a.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL
k.CreateDirectoryW.argtypes = [w.LPCWSTR, c.POINTER(p.SecurityAttributes)]
k.CreateDirectoryW.restype = w.BOOL
k.LocalFree.argtypes = [c.c_void_p]
k.LocalFree.restype = c.c_void_p


def create_owned_directory(directory, sid, writable=False):
    sid_text = w.LPWSTR()
    p.p.check(a.ConvertSidToStringSidW(sid, c.byref(sid_text)), 'format temporary profile SID')
    descriptor = c.c_void_p()
    try:
        # Both DACLs are applied only while creating unique owned directories.
        # Never grant the AppContainer SID rights on the parent or host paths.
        rights = 'FA' if writable else '0x1200a9'
        sddl = f'D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;{rights};;;{sid_text.value})'
        p.p.check(a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None), 'create private descriptor')
        attributes = p.SecurityAttributes(c.sizeof(p.SecurityAttributes), descriptor, False)
        p.p.check(k.CreateDirectoryW(str(directory), c.byref(attributes)), 'create owned dependency directory')
    finally:
        if descriptor.value:
            k.LocalFree(descriptor)
        k.LocalFree(c.cast(sid_text, c.c_void_p))


def main():
    node = shutil.which('node')
    ffmpeg = shutil.which('ffmpeg')
    ffprobe = shutil.which('ffprobe')
    if not node or not ffmpeg or not ffprobe:
        raise RuntimeError('Node, ffmpeg or ffprobe unavailable')
    store = ROOT / 'node_modules' / '.pnpm'
    resvg = store / '@resvg+resvg-js@2.6.2' / 'node_modules' / '@resvg' / 'resvg-js'
    native = store / '@resvg+resvg-js-win32-x64-msvc@2.6.2' / 'node_modules' / '@resvg' / 'resvg-js-win32-x64-msvc'
    esbuild = ROOT / 'node_modules' / 'esbuild' / 'bin' / 'esbuild'
    secret_name = 'GLINT_PROBE_SECRET_' + uuid.uuid4().hex
    secret = uuid.uuid4().hex
    os.environ[secret_name] = secret
    try:
        with tempfile.TemporaryDirectory(prefix='glint-owned-worker-') as tmp:
            root = pathlib.Path(tmp)
            stage = root / 'dependency-view'
            work = root / 'work'
            inp, out, private = root / 'input', root / 'output', root / 'private'
            private.write_text('PRIVATE_SENTINEL', encoding='utf8')
            project_path = stage / 'project.json'
            output_path = work / 'render.mp4'
            inp.write_text(json.dumps({'id': 'missing-path', 'args': []}) + '\n' + json.dumps({'id': 'real-project', 'args': ['--project=' + str(project_path), '--out=' + str(output_path), '--fast', '--tts=mock', '--music=off']}) + '\n' + json.dumps({'type': 'shutdown'}) + '\n', encoding='utf8')
            out.write_bytes(b'')
            bundle = root / 'build.mjs'
            cmd = [node, str(esbuild), str(ROOT / 'apps/studio/scripts/native-worker.ts'), '--bundle', '--platform=node', '--format=esm', '--target=node24', '--external:@resvg/resvg-js', '--banner:js=import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);', '--outfile=' + str(bundle)]
            build = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            print('bundle exit:', build.returncode)
            if build.returncode:
                raise RuntimeError('bundle failed: ' + build.stderr[-4000:])
            print('bundle bytes:', bundle.stat().st_size)
            def prepare(sid):
                create_owned_directory(stage, sid)
                create_owned_directory(work, sid, writable=True)
                package = stage / 'node_modules' / '@resvg'
                package.mkdir(parents=True)
                shutil.copytree(resvg, package / 'resvg-js', symlinks=False)
                shutil.copytree(native, package / 'resvg-js-win32-x64-msvc', symlinks=False)
                shutil.copy2(bundle, stage / 'native-worker.mjs')
                shutil.copy2(ffmpeg, stage / 'ffmpeg.exe')
                project = json.loads((ROOT / 'examples' / 'charts' / 'project.scenescript.json').read_text(encoding='utf8'))
                project['scenes'][0]['duration'] = 0.5
                project_path.write_text(json.dumps(project, ensure_ascii=False), encoding='utf8')
                check = '''import fs from 'node:fs'; import net from 'node:net';
const secret=process.env.GLINT_CHECK_SECRET_NAME, privatePath=process.env.GLINT_CHECK_PRIVATE, stagedPath=process.env.GLINT_CHECK_STAGE, port=process.env.GLINT_CHECK_PORT;
const result = {secretAbsent: !(secret in process.env)};
try { fs.mkdtempSync(stagedPath); result.readonlyTempDenied=false; } catch(e) { result.readonlyTempDenied=e.code==='EACCES' || e.code==='EPERM'; }
try { fs.writeFileSync(privatePath+'-sibling', 'x'); result.siblingWriteDenied=false; } catch(e) { result.siblingWriteDenied=e.code==='EACCES' || e.code==='EPERM'; }
try { fs.readFileSync(privatePath); result.privateDenied=false; } catch(e) { result.privateDenied=e.code==='EACCES' || e.code==='EPERM'; }
try { fs.writeFileSync(stagedPath, 'x'); result.stageWriteDenied=false; } catch(e) { result.stageWriteDenied=e.code==='EACCES' || e.code==='EPERM'; }
result.networkDenied=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:Number(port)});s.setTimeout(1500);s.on('connect',()=>{s.destroy();resolve(false);});s.on('error',()=>resolve(true));s.on('timeout',()=>{s.destroy();resolve(true);});});
console.log(JSON.stringify({boundary:result}));'''
                (stage / 'boundary-check.mjs').write_text(check, encoding='utf8')
                harness = '''process.env.TEMP=process.env.GLINT_WORK; process.env.TMP=process.env.GLINT_WORK;
await import('./boundary-check.mjs');
const fs=await import('node:fs'); const os=await import('node:os'); const cp=await import('node:child_process');
const test=fs.mkdtempSync(os.tmpdir()+'\\\\probe-'); fs.writeFileSync(test+'\\\\file','ok'); fs.rmSync(test,{recursive:true});
console.log(JSON.stringify({tempProbe:'ok', tmp:os.tmpdir()}));
try { const ff=cp.spawn('ffmpeg',['-version'],{stdio:'ignore'});
  console.log(JSON.stringify({ffmpegSpawn:{pid:ff.pid}}));
  ff.on('error',e=>console.log(JSON.stringify({ffmpegError:e.message})));
  ff.on('close',code=>console.log(JSON.stringify({ffmpegClose:code})));
} catch(e) { console.log(JSON.stringify({ffmpegSpawnError:e.code})); }
const {serveNativeWorker}=await import('./native-worker.mjs');
process.stdin.setEncoding('utf8');
await serveNativeWorker(process.stdin, process.cwd());'''
                (stage / 'harness.mjs').write_text(harness, encoding='utf8')
            env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root), 'TEMP': str(root), 'TMP': str(root), 'GLINT_WORK': str(work), 'GLINT_CACHE_DIR': str(work / 'cache'), 'PATH': str(stage), 'GLINT_PROCESS_LEDGER': str(work / 'ledger.jsonl')}
            timed_out = False
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                listener.listen(1)
                listener.settimeout(2)
                port = listener.getsockname()[1]
                with socket.create_connection(('127.0.0.1', port), timeout=2):
                    accepted, _ = listener.accept()
                    accepted.close()
                env.update({'GLINT_CHECK_SECRET_NAME': secret_name, 'GLINT_CHECK_PRIVATE': str(private), 'GLINT_CHECK_STAGE': str(stage / 'bad'), 'GLINT_CHECK_PORT': str(port)})
                try:
                    code, elapsed = p.run(None, inp, out, executable=node, arguments=['--preserve-symlinks', '--preserve-symlinks-main', str(stage / 'harness.mjs')], environment=env, prepare_profile=prepare, memory_limit=1024*1024*1024, cpu_ms=30000, deadline_ms=25000)
                except TimeoutError:
                    timed_out, code, elapsed = True, None, 25
                    print('worker timeout; owned process terminated by launcher')
                try:
                    accepted, _ = listener.accept()
                    accepted.close()
                    observed = True
                except socket.timeout:
                    observed = False
            result = out.read_text(encoding='utf8', errors='replace')
            print('worker exit:', code, 'elapsed:', round(elapsed, 2))
            print('worker output:', result[-6000:])
            if secret in result:
                raise AssertionError('secret reached worker output')
            if not timed_out and code != 0:
                raise AssertionError('worker process failed')
            if '"id":"missing-path"' not in result or '"status":"error"' not in result:
                raise AssertionError('worker request path NOT demonstrated')
            rows = []
            for line in result.splitlines():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            boundary = next(row['boundary'] for row in rows if 'boundary' in row)
            if not all(boundary.get(key) is True for key in ('secretAbsent', 'privateDenied', 'stageWriteDenied', 'readonlyTempDenied', 'siblingWriteDenied', 'networkDenied')) or observed:
                raise AssertionError(f'boundary check failed: {boundary}, connection observed={observed}')
            if (stage / 'bad').exists() or private.read_text(encoding='utf8') != 'PRIVATE_SENTINEL':
                raise AssertionError('fixture integrity failed')
            if not any(row.get('tempProbe') == 'ok' and pathlib.Path(row.get('tmp', '')) == work for row in rows):
                raise AssertionError('owned temporary workspace was not verified')
            render = next((row for row in rows if row.get('id') == 'real-project'), None)
            print('real project result:', render if render else 'timeout without response', 'output exists:', output_path.exists())
            print('real worker loaded; temp writable; secret/file/write/loopback boundary checks passed; listener observed:', observed)
            if timed_out or not render or render.get('status') != 'done':
                raise RuntimeError('real render not completed; see worker output above')
            probe = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', str(output_path)], capture_output=True, text=True, timeout=15)
            if probe.returncode or not json.loads(probe.stdout).get('streams'):
                raise AssertionError('rendered video failed ffprobe verification')
            print('verified video:', probe.stdout)
    finally:
        del os.environ[secret_name]


if __name__ == '__main__':
    main()
