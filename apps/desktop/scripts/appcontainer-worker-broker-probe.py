"""MOTION-09 end-to-end confined render through the encoder broker; experiment only.

The real native worker runs inside an AppContainer and never spawns FFmpeg: its
two encoder argv templates are matched exactly by an experiment-injected
node:child_process stand-in and delegated over inherited anonymous pipes to
broker whitelist ops executed in a second disposable confinement. The result is
verified with ffprobe. Negative contrasts cover the runtime output quota, a
protocol stall deadline, mid-render cancellation and private-path/template
refusal. Only self-created fixtures, profiles and processes are touched; no ACLs
change; Web rendering stays rejected. This is not a production sandbox.
"""
import importlib.util
import json
import os
import pathlib
import secrets
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import uuid
import zlib

if os.name != 'nt':
    raise SystemExit('Windows only')

ROOT = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('broker', pathlib.Path(__file__).with_name('appcontainer-broker-prototype.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
worker, handle = broker.worker, broker.worker.p
kernel, peek = handle.k, handle.c

DEADLINE_MS = 90000
CPU_MS = 60000
MEMORY_LIMIT = 1024 * 1024 * 1024
FRAME_BUFFER_LIMIT = 64 * 1024 * 1024
RESVG = ROOT / 'node_modules' / '.pnpm' / '@resvg+resvg-js@2.6.2' / 'node_modules' / '@resvg' / 'resvg-js'
RESVG_NATIVE = ROOT / 'node_modules' / '.pnpm' / '@resvg+resvg-js-win32-x64-msvc@2.6.2' / 'node_modules' / '@resvg' / 'resvg-js-win32-x64-msvc'

# Confined-media stand-in bundled over node:child_process via esbuild --alias.
# FFmpeg spawns must match the renderer's exact templates; only whitelisted
# fields (framerate, preset, crf) reach the parent and argv is rebuilt there.
DELEGATE_SOURCE = r'''
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const real = createRequire(import.meta.url)('node:child_process');

// path.resolve only: realpathSync would lstat the drive root, which the
// AppContainer cannot stat. The base path is parent-supplied via env.
const work = path.resolve(process.env.GLINT_WORK);
const state = { active: null, fps: 0, inbox: Buffer.alloc(0), waiters: [] };
globalThis.__glintBroker = state;

function fail(message) { throw new Error('confined broker refused: ' + message); }

function insideWork(candidate) {
  if (typeof candidate !== 'string' || !candidate) fail('empty path');
  const relative = path.relative(work, path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('path escapes owned workspace: ' + candidate);
  return path.resolve(candidate);
}

const FRAMERATE = /^\d{1,3}(\/\d{1,3})?$/;
function parseEncode(args) {
  // Production template (native-process startPngEncoder):
  // -v error -y -f image2pipe -framerate FR -i - -c:v libx264 -preset P -crf C -pix_fmt yuv420p -movflags +faststart -an OUT
  const head = ['-v', 'error', '-y', '-f', 'image2pipe'];
  if (args.length !== 21 || head.some((token, index) => args[index] !== token)) fail('clip template mismatch');
  if (args[5] !== '-framerate' || !FRAMERATE.test(args[6])) fail('clip framerate');
  if (args[7] !== '-i' || args[8] !== '-') fail('clip input must be stdin');
  const tail = args.slice(9);
  const preset = tail[3], crf = tail[5];
  if (!['veryfast', 'medium'].includes(preset) || !['24', '20'].includes(crf)) fail('clip encoding preset');
  const fixed = ['-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];
  if (fixed.some((token, index) => tail[index] !== token) || tail.length !== 12) fail('clip tail template mismatch');
  return { op: 'encode_png', framerate: args[6], preset, crf, output: insideWork(tail[11]) };
}

function parseConcat(args) {
  // Production template (native-render concat branch):
  // -v error -y -f concat -safe 0 -i LIST -map 0:v:0 -c:v copy -movflags +faststart -t DUR OUT
  const head = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i'];
  if (args.length !== 18 || head.some((token, index) => args[index] !== token)) fail('container template mismatch');
  const list = insideWork(args[8]);
  const rest = args.slice(9);
  const fixed = ['-map', '0:v:0', '-c:v', 'copy', '-movflags', '+faststart', '-t'];
  if (fixed.some((token, index) => rest[index] !== token) || rest.length !== 9) fail('container tail template mismatch');
  if (!/^\d+(\.\d+)?$/.test(rest[7])) fail('container duration');
  if (!(state.fps >= 1 && state.fps <= 30)) fail('project fps unknown');
  const clips = fs.readFileSync(list, 'utf8').split('\n').filter(line => line.trim()).map(line => {
    const match = /^file '(.+)'$/.exec(line.trim());
    if (!match) fail('concat list line');
    return insideWork(match[1]);
  });
  if (clips.length < 1 || clips.length > 30) fail('concat clip count');
  return { op: 'concat_clips', clips, fps: state.fps, output: insideWork(rest[8]) };
}

async function rawWrite(bytes) {
  await new Promise((resolve, reject) => process.stderr.write(bytes, error => error ? reject(error) : resolve()));
}

async function readExact(count) {
  while (state.inbox.length < count) await new Promise(resolve => state.waiters.push(resolve));
  const chunk = state.inbox.subarray(0, count);
  state.inbox = state.inbox.subarray(count);
  return chunk;
}

async function readLine() {
  let buffer = Buffer.alloc(0);
  for (;;) {
    const newline = buffer.indexOf(0x0a);
    if (newline >= 0) return buffer.subarray(0, newline).toString();
    buffer = Buffer.concat([buffer, await readExact(1)]);
  }
}

function header(op, sequence, length) {
  const buffer = Buffer.alloc(10);
  buffer[0] = 1; buffer[1] = op;
  buffer.writeUInt32BE(sequence, 2); buffer.writeUInt32BE(length, 6);
  return buffer;
}

async function message(op, sequence, body) {
  await rawWrite(Buffer.concat([header(op, sequence, body.length), body]));
  const ack = await readExact(1);
  if (ack[0] !== 6) fail('broker acknowledgement');
}

async function runOp(parsed) {
  state.active = parsed;
  await rawWrite(Buffer.from('READY ' + parsed.op + '\n'));
  if (process.env.GLINT_BROKER_STALL === '1') await new Promise(() => {});
  const token = await readExact(32);
  await message(1, 0, token);
  // concat clips are worker-side files validated at spawn; their BYTES travel,
  // never the paths.
  const blobs = parsed.op === 'encode_png' ? parsed.frames
    : parsed.clips.map(file => fs.readFileSync(file));
  if (!Array.isArray(blobs) || blobs.length < 1 || blobs.length > 30) fail('blob count');
  if (blobs.some(blob => !Buffer.isBuffer(blob) || blob.length < 1 || blob.length > 1048576)) fail('blob size');
  let fps;
  if (parsed.op === 'encode_png') {
    const parts = parsed.framerate.split('/').map(Number);
    fps = Math.round(parts.length === 2 ? parts[0] / parts[1] : parts[0]);
  } else {
    fps = parsed.fps;
  }
  if (!(fps >= 1 && fps <= 30)) fail('frame rate');
  const begin = Buffer.alloc(8);
  begin.writeUInt32BE(blobs.length, 0); begin.writeUInt32BE(fps, 4);
  await message(2, 0, begin);
  for (let index = 0; index < blobs.length; index++) await message(3, index, blobs[index]);
  await message(4, blobs.length, Buffer.alloc(0));
  const result = JSON.parse(await readLine());
  if (result.broker !== 'result' || !/^[A-Za-z0-9._-]{1,64}$/.test(result.file || '')) fail('result descriptor');
  const produced = path.join(work, result.file);
  const stat = fs.statSync(produced);
  if (!stat.isFile() || stat.size !== result.bytes || stat.size === 0) fail('result size');
  fs.renameSync(produced, parsed.output);
  state.active = null;
}

function makeFrameCollector(parsed) {
  const events = new EventEmitter();
  let total = 0;
  parsed.frames = [];
  return Object.assign(new EventEmitter(), {
    on(event, handler) { events.on(event, handler); return this; },
    write(frame) {
      total += frame.length;
      if (total > FRAME_BUFFER_LIMIT_PLACEHOLDER) {
        events.emit('error', new Error('frame buffer exceeds broker input limit'));
        return true;
      }
      parsed.frames.push(Buffer.from(frame));
      return true;
    },
    end() { parsed.start(); },
  });
}

function fakeChild(parsed, immediate) {
  const listeners = { error: [], close: [] };
  let settledOnce = false;
  const settle = (code, error) => {
    if (settledOnce) return;
    settledOnce = true;
    queueMicrotask(() => {
      for (const handler of error ? [...listeners.error, ...listeners.close] : listeners.close) handler(error ?? code);
    });
  };
  parsed.started = new Promise(resolve => { parsed.start = resolve; });
  if (immediate) queueMicrotask(parsed.start);
  // The outcome drives the fake child's close/error events; the no-op catch
  // keeps a rejection from ever becoming unhandled before a consumer attaches.
  parsed.outcome = (async () => {
    try { await runOp(parsed); settle(0, null); } catch (error) { settle(1, error); }
  })();
  parsed.outcome.catch(() => {});
  return {
    pid: undefined,
    stdin: parsed.op === 'encode_png' ? makeFrameCollector(parsed) : null,
    stderr: new EventEmitter(),
    kill() { settle(1, new Error('encoder cancelled by kill')); return true; },
    once(event, handler) { (listeners[event] ??= []).push(handler); return this; },
  };
}

export function spawn(command, args) {
  if (command !== 'ffmpeg') fail('non-ffmpeg spawn is not delegable: ' + command);
  if (!Array.isArray(args) || args.length < 5) fail('argument vector expected');
  const parsed = args[4] === 'image2pipe' ? parseEncode(args) : args[4] === 'concat' ? parseConcat(args) : fail('unmatched ffmpeg template');
  return fakeChild(parsed, parsed.op === 'concat_clips');
}
// spawnSync inside the confinement hangs on process creation (measured:
// spawnSync('where') never returns under AppContainer), so it fails closed;
// the only caller (ffmpegIdentity) catches and reports an unverified identity.
export const spawnSync = () => { throw new Error('confined broker refused: spawnSync is not delegable'); };
export const execFile = real.execFile;
export const exec = real.exec;
export const fork = real.fork;
export const execFileSync = real.execFileSync;
export const execSync = real.execSync;
export const ChildProcess = real.ChildProcess;
export default { ...real, spawn };
'''.replace('FRAME_BUFFER_LIMIT_PLACEHOLDER', str(FRAME_BUFFER_LIMIT))

BOUNDARY_CHECK_SOURCE = '''import fs from 'node:fs'; import net from 'node:net';
const secret=process.env.GLINT_CHECK_SECRET_NAME, privatePath=process.env.GLINT_CHECK_PRIVATE, stagedPath=process.env.GLINT_CHECK_STAGE, port=process.env.GLINT_CHECK_PORT;
const result = {secretAbsent: !(secret in process.env)};
try { fs.mkdtempSync(stagedPath); result.readonlyTempDenied=false; } catch(e) { result.readonlyTempDenied=e.code==='EACCES' || e.code==='EPERM'; }
try { fs.writeFileSync(privatePath+'-sibling', 'x'); result.siblingWriteDenied=false; } catch(e) { result.siblingWriteDenied=e.code==='EACCES' || e.code==='EPERM'; }
try { fs.readFileSync(privatePath); result.privateDenied=false; } catch(e) { result.privateDenied=e.code==='EACCES' || e.code==='EPERM'; }
try { fs.writeFileSync(stagedPath, 'x'); result.stageWriteDenied=false; } catch(e) { result.stageWriteDenied=e.code==='EACCES' || e.code==='EPERM'; }
result.networkDenied=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:Number(port)});s.setTimeout(1500);s.on('connect',()=>{s.destroy();resolve(false);});s.on('error',()=>resolve(true));s.on('timeout',()=>{s.destroy();resolve(true);});});
console.log(JSON.stringify({boundary:result}));'''

HARNESS_SOURCE = '''process.env.TEMP=process.env.GLINT_WORK; process.env.TMP=process.env.GLINT_WORK;
// fd 2 is the media uplink. Preserve console diagnostics as stdout JSON lines.
const { format } = await import('node:util');
for (const level of ['warn', 'error']) {
  console[level] = (...values) => process.stdout.write(JSON.stringify({diagnostic: {level, message: format(...values)}}) + '\\n');
}
await import('./boundary-check.mjs');
const fsx = await import('node:fs'); const osx = await import('node:os');
const probe = fsx.mkdtempSync(osx.tmpdir() + '/probe-'); fsx.writeFileSync(probe + '/file', 'ok'); fsx.rmSync(probe, {recursive: true});
console.log(JSON.stringify({tempProbe: 'ok', tmp: osx.tmpdir()}));
const stream = await import('node:stream');
const feed = new stream.PassThrough();
// fd 0 is dual-use and strictly sequential: JSON request lines while no broker
// op is active, then the broker downlink (token, per-message ACKs, RESULT line).
// __glintBroker appears only once the aliased bundle has been imported, so the
// router reads it lazily per event.
let pending = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  const broker = globalThis.__glintBroker;
  if (broker && broker.active) { broker.inbox = Buffer.concat([broker.inbox, chunk]); while (broker.waiters.length) broker.waiters.shift()(); return; }
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const newline = pending.indexOf(0x0a);
    if (newline < 0) break;
    const line = pending.subarray(0, newline).toString(); pending = pending.subarray(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.args) {
      const projectArg = request.args.find(arg => arg.startsWith('--project='));
      const brokerState = globalThis.__glintBroker;
      if (projectArg && brokerState) brokerState.fps = JSON.parse(fsx.readFileSync(projectArg.slice(10), 'utf8')).fps ?? 30;
    }
    feed.write(line + '\\n');
  }
});
process.stdin.on('end', () => feed.end());
const { serveNativeWorker } = await import('./native-worker.mjs');
await serveNativeWorker(feed, process.cwd());
console.log(JSON.stringify({ harness: 'done' }));
// The router's stdin reader would otherwise hold the event loop open forever.
process.stdin.destroy();
process.exit(0);'''

ABUSE_SOURCE = '''import { spawn } from './confined-media.mjs';
const results = {};
const encodeTemplate = output => ['-v','error','-y','-f','image2pipe','-framerate','24','-i','-','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart','-an', output];
const attempt = (name, fn) => { try { fn(); results[name] = 'ALLOWED'; } catch (error) { results[name] = String(error.message).startsWith('confined broker refused:') ? 'refused' : 'other:' + error.message; } };
attempt('privateOutput', () => spawn('ffmpeg', encodeTemplate(process.env.GLINT_CHECK_PRIVATE)));
attempt('siblingOutput', () => spawn('ffmpeg', encodeTemplate(process.env.GLINT_CHECK_SIBLING)));
attempt('nonFfmpeg', () => spawn('cmd.exe', ['/c', 'echo']));
attempt('unmatchedTemplate', () => spawn('ffmpeg', ['-i', 'x.mp4']));
console.log(JSON.stringify({ abuse: results }));'''


def project_scenes():
    """Real charts project, plus one more chart scene so the container op is real.

    narration.durationMs is explicit because timeline resolution takes the
    narration duration (or a text estimate) and ignores scene.duration; without
    it the mock estimate would exceed the broker's 30-frame op bound.
    """
    project = json.loads((ROOT / 'examples' / 'charts' / 'project.scenescript.json').read_text(encoding='utf8'))
    project['scenes'][0]['duration'] = 0.5
    project['scenes'][0]['narration']['durationMs'] = 500
    trend = json.loads(json.dumps(project['scenes'][0]))
    trend.update({'id': 'quarterly-trend', 'chartType': 'line',
                  'data': [{'label': '第一季度', 'value': 12}, {'label': '第二季度', 'value': 34},
                           {'label': '第三季度', 'value': 28}, {'label': '第四季度', 'value': 51}]})
    project['scenes'].append(trend)
    return project


def _pipe_wait(fd):
    available = peek.c_uint32()
    if not kernel.PeekNamedPipe(handle.msvcrt.get_osfhandle(fd), None, 0, None, peek.byref(available), None):
        raise broker.ContractError('pipe closed while awaiting data')
    return available.value


def media_line(media_fd, deadline):
    """Read one newline-terminated marker from the media uplink, never over-reading."""
    buffer = bytearray()
    while b'\n' not in buffer:
        if time.monotonic() >= deadline:
            raise TimeoutError('media marker deadline exceeded')
        available = _pipe_wait(media_fd)
        if available:
            buffer.extend(os.read(media_fd, available))
        else:
            time.sleep(0.01)
    newline = buffer.index(b'\n')
    if buffer[newline + 1:]:
        raise AssertionError(f'unexpected bytes after media marker: {bytes(buffer[newline + 1:])!r}')
    return bytes(buffer[:newline]).decode()


def json_response(response_fd, deadline, request_id, rows):
    """Collect stdout until the JSON row for request_id arrives; every parsed row is kept."""
    buffer = bytearray()
    while time.monotonic() < deadline:
        available = _pipe_wait(response_fd)
        if available:
            buffer.extend(os.read(response_fd, available))
        while b'\n' in buffer:
            newline = buffer.index(b'\n')
            line = bytes(buffer[:newline])
            del buffer[:newline + 1]
            try:
                row = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                print('worker stdout:', line.decode('utf8', errors='backslashreplace'))
                continue
            if not isinstance(row, dict):
                print('worker stdout JSON:', json.dumps(row, ensure_ascii=True))
                continue
            if 'diagnostic' in row:
                print('worker diagnostic:', json.dumps(row['diagnostic'], ensure_ascii=True))
            rows.append(row)
            if row.get('id') == request_id:
                return row
        time.sleep(0.01)
    raise TimeoutError(f'no response for {request_id}')


def _drain(fd, limit=16384):
    """Best-effort drain of whatever bytes are buffered on an owned pipe."""
    buffer = bytearray()
    try:
        while len(buffer) < limit:
            available = _pipe_wait(fd)
            if not available:
                break
            buffer.extend(os.read(fd, available))
    except (broker.ContractError, OSError):
        pass
    return bytes(buffer)


def broker_session(request_fd, response_fd, media_fd, work, stage, ffmpeg, behavior=None):
    """Serve exactly one render request: one whitelist op per plan step.

    No worker path ever reaches an op: blobs are matched by position to the plan
    this process derived from the project it wrote itself.
    """
    deadline = time.monotonic() + DEADLINE_MS / 1000
    rows = []
    os.write(request_fd, (json.dumps({'id': 'missing-path', 'args': []}) + '\n').encode())
    try:
        rejected = json_response(response_fd, deadline, 'missing-path', rows)
    except broker.ContractError as error:
        raise AssertionError(f'worker died before responding; media uplink: {_drain(media_fd)!r}') from error
    if rejected.get('status') != 'error':
        raise AssertionError('missing-path request must fail structurally')
    print('request path demonstrated: missing-path ->', str(rejected.get('error'))[:60])

    request_id = 'real-project'
    render = {'id': request_id, 'args': ['--project=' + str(stage / 'project.json'),
                                         '--out=' + str(work / 'render.mp4'), '--fast', '--tts=mock', '--music=off']}
    os.write(request_fd, (json.dumps(render) + '\n').encode())

    plan = [{'kind': 'encode_png'}, {'kind': 'encode_png'}, {'kind': 'concat_clips', 'duration_frames': 24}]
    for index, op in enumerate(plan):
        try:
            ready = media_line(media_fd, deadline)
        except TimeoutError as error:
            raise AssertionError(f'no READY marker; worker stdout said: {_drain(response_fd)!r}') from error
        if ready != f"READY {op['kind']}":
            raise AssertionError(f'unexpected media marker {ready!r}, expected {op["kind"]}')
        token = secrets.token_bytes(32)
        os.write(request_fd, token)
        blobs, settings = [], []
        broker.serve_pipe(media_fd, request_fd, token, lambda seq, data: blobs.append(data),
                          lambda frames, fps: settings.append((frames, fps)))
        if behavior == 'cancel' and index == 1:
            raise RuntimeError('deliberate cancellation')
        if op['kind'] == 'encode_png':
            blob = broker.encode_png_clip(blobs, settings[0][1], ffmpeg)
        else:
            blob = broker.concat_clips(blobs, settings[0][1], op['duration_frames'], ffmpeg)
        result_name = f'broker-result-{index}.mp4'
        (work / result_name).write_bytes(blob)
        os.write(request_fd, (json.dumps({'broker': 'result', 'file': result_name, 'bytes': len(blob)}) + '\n').encode())
        print(f'op {index}: {op["kind"]} served, {len(blob)} bytes under broker limits')
    response = json_response(response_fd, deadline, request_id, rows)
    os.write(request_fd, b'{"type":"shutdown"}\n')
    return response, rows


def run_captured(command, *, timeout, cwd=None):
    """Capture bytes first so locale decoding cannot lose child diagnostics."""
    result = subprocess.run(command, capture_output=True, timeout=timeout, cwd=cwd)
    for name in ('stdout', 'stderr'):
        data = getattr(result, name)
        if data:
            print(f'{pathlib.Path(command[0]).name} {name}:',
                  data.decode('utf8', errors='backslashreplace'), end='\n')
    if result.returncode:
        raise RuntimeError(f'{pathlib.Path(command[0]).name} exited {result.returncode}')
    return result


def run_confined(root, ffmpeg, behavior=None, deadline_ms=DEADLINE_MS):
    """Bundle the real worker once and launch it confined; returns (code, elapsed, rows)."""
    stage, work = root / 'dependency-view', root / 'work'
    node, esbuild = shutil.which('node'), ROOT / 'node_modules' / 'esbuild' / 'bin' / 'esbuild'

    delegate, bundle = root / 'confined-media.mjs', root / 'native-worker.mjs'
    delegate.write_text(DELEGATE_SOURCE, encoding='utf8')
    run_captured([node, str(esbuild), str(ROOT / 'apps/studio/scripts/native-worker.ts'), '--bundle',
                  '--platform=node', '--format=esm', '--target=node24', '--external:@resvg/resvg-js',
                  f'--alias:node:child_process={delegate}',
                  '--banner:js=import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);',
                  f'--outfile={bundle}'], timeout=120, cwd=str(root))
    print('bundle bytes:', bundle.stat().st_size)

    secret_name = 'GLINT_PROBE_SECRET_' + uuid.uuid4().hex
    secret = uuid.uuid4().hex
    os.environ[secret_name] = secret
    (root / 'private').write_text('PRIVATE_SENTINEL', encoding='utf8')
    hold = {}
    try:
        def prepare(sid):
            worker.create_owned_directory(stage, sid)
            worker.create_owned_directory(work, sid, writable=True)
            package = stage / 'node_modules' / '@resvg'
            package.mkdir(parents=True)
            shutil.copytree(RESVG, package / 'resvg-js', symlinks=False)
            shutil.copytree(RESVG_NATIVE, package / 'resvg-js-win32-x64-msvc', symlinks=False)
            shutil.copy2(bundle, stage / 'native-worker.mjs')
            shutil.copy2(delegate, stage / 'confined-media.mjs')
            shutil.copy2(ffmpeg, stage / 'ffmpeg.exe')
            (stage / 'project.json').write_text(json.dumps(project_scenes(), ensure_ascii=False), encoding='utf8')
            (stage / 'boundary-check.mjs').write_text(BOUNDARY_CHECK_SOURCE, encoding='utf8')
            (stage / 'harness.mjs').write_text(HARNESS_SOURCE, encoding='utf8')

        env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root), 'TEMP': str(work), 'TMP': str(work),
               'GLINT_WORK': str(work), 'GLINT_CACHE_DIR': str(work / 'cache'), 'PATH': str(stage),
               'GLINT_PROCESS_LEDGER': str(work / 'ledger.jsonl'), 'GLINT_CHECK_SECRET_NAME': secret_name,
               'GLINT_CHECK_PRIVATE': str(root / 'private'), 'GLINT_CHECK_STAGE': str(stage / 'bad')}
        if behavior == 'stall':
            env['GLINT_BROKER_STALL'] = '1'

        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            listener.settimeout(2)
            env['GLINT_CHECK_PORT'] = str(listener.getsockname()[1])
            # Positive control: the same listener is reachable from this process.
            with socket.create_connection(('127.0.0.1', env['GLINT_CHECK_PORT']), timeout=2):
                accepted, _ = listener.accept()
                accepted.close()

            def broker_handler(request_fd, response_fd, media_fd, process, handler_deadline):
                response, rows = broker_session(request_fd, response_fd, media_fd, work, stage, ffmpeg, behavior)
                hold['rows'] = rows
                return response

            saved_deadline = broker.IPC_DEADLINE_SECONDS
            broker.IPC_DEADLINE_SECONDS = 4 if behavior == 'stall' else saved_deadline
            try:
                code, elapsed = handle.run(None, None, None, executable=node,
                    arguments=['--preserve-symlinks', '--preserve-symlinks-main', str(stage / 'harness.mjs')],
                    environment=env, prepare_profile=prepare, memory_limit=MEMORY_LIMIT,
                    cpu_ms=CPU_MS, deadline_ms=deadline_ms, broker_handler=broker_handler)
            finally:
                broker.IPC_DEADLINE_SECONDS = saved_deadline
            try:
                accepted, _ = listener.accept()
                accepted.close()
                raise AssertionError('worker reached the owned loopback listener')
            except socket.timeout:
                pass
        return code, elapsed, hold.get('rows')
    finally:
        del os.environ[secret_name]


def assert_fixture_integrity(root):
    if (root / 'private').read_text(encoding='utf8') != 'PRIVATE_SENTINEL' or (root / 'sibling-sentinel').exists():
        raise AssertionError('private fixture was touched')
    print('private sentinel intact; sibling never created')


def assert_boundary_rows(rows, work):
    boundary = next(row['boundary'] for row in rows if 'boundary' in row)
    if not all(boundary.get(key) is True for key in ('secretAbsent', 'privateDenied', 'stageWriteDenied',
                                                     'siblingWriteDenied', 'readonlyTempDenied', 'networkDenied')):
        raise AssertionError(f'boundary check failed: {boundary}')
    temp = next(row for row in rows if row.get('tempProbe') == 'ok')
    if os.path.normcase(str(pathlib.Path(temp['tmp']).resolve())) != os.path.normcase(str(work.resolve())):
        raise AssertionError(f'owned temporary workspace was not verified: {temp}')
    print('boundary verified inside confinement:', json.dumps(boundary, ensure_ascii=False),
          '; owned temp:', temp['tmp'])


def main():
    node, ffmpeg, ffprobe = shutil.which('node'), shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not all((node, ffmpeg, ffprobe)):
        raise RuntimeError('Node, ffmpeg or ffprobe unavailable')

    # 1. End-to-end: real worker, real charts project, broker-delegated encode.
    with tempfile.TemporaryDirectory(prefix='glint-owned-worker-broker-') as tmp:
        root = pathlib.Path(tmp)
        code, elapsed, rows = run_confined(root, ffmpeg)
        print(f'success run: exit={code} elapsed={elapsed:.2f}s')
        if code != 0:
            raise AssertionError('worker exited nonzero on the success path')
        assert_fixture_integrity(root)
        assert_boundary_rows(rows, root / 'work')
        ledger = root / 'work' / 'ledger.jsonl'
        ledger_rows = [json.loads(line) for line in ledger.read_text(encoding='utf8').splitlines()] if ledger.exists() else []
        if any(row.get('command') == 'ffmpeg' for row in ledger_rows):
            raise AssertionError('worker recorded an ffmpeg spawn; delegation was bypassed')
        print(f'process ledger: {len(ledger_rows)} rows; the confined worker spawned no ffmpeg process')
        probe = subprocess.run([ffprobe, '-v', 'error', '-count_frames', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
            '-show_entries', 'format=duration', '-of', 'json', str(root / 'work' / 'render.mp4')],
            capture_output=True, text=True, timeout=15, check=True)
        probed = json.loads(probe.stdout)
        stream = probed['streams'][0]
        if {key: stream[key] for key in ('codec_name', 'width', 'height', 'nb_read_frames')} != \
                {'codec_name': 'h264', 'width': 960, 'height': 540, 'nb_read_frames': '24'}:
            raise AssertionError(f'unexpected stream: {stream}')
        if abs(float(probed['format']['duration']) - 1.0) >= 0.2:
            raise AssertionError(f'unexpected duration: {probed["format"]}')
        print('ffprobe verified:', json.dumps({**stream, 'duration': probed['format']['duration']}))
        if not (root / 'work' / 'render.mp4.metrics.json').exists():
            raise AssertionError('render receipt missing')
        print('metrics receipt written by the confined worker')

    # 2. Stall: delegate never sends AUTH; the contract deadline fires and the
    #    owned worker is terminated by the launcher.
    with tempfile.TemporaryDirectory(prefix='glint-owned-worker-stall-') as tmp:
        root = pathlib.Path(tmp)
        try:
            run_confined(root, ffmpeg, behavior='stall')
            raise AssertionError('stall run must fail')
        except broker.ContractError as error:
            print('stall negative: contract deadline enforced ->', error)
        if (root / 'work' / 'render.mp4').exists():
            raise AssertionError('stalled run produced output')
        assert_fixture_integrity(root)

    # 3. Cancel: cancel between clip ops; the worker dies mid-render, output absent.
    with tempfile.TemporaryDirectory(prefix='glint-owned-worker-cancel-') as tmp:
        root = pathlib.Path(tmp)
        try:
            run_confined(root, ffmpeg, behavior='cancel')
            raise AssertionError('cancel run must fail')
        except RuntimeError as error:
            if 'deliberate cancellation' not in str(error):
                raise
            print('cancel negative: mid-render cancellation -> owned worker terminated')
        if (root / 'work' / 'render.mp4').exists():
            raise AssertionError('cancelled run produced output')
        # The first clip result was delivered (renamed into the render workspace)
        # before cancellation, proving the cancel point is mid-render.
        if not list((root / 'work').glob('glint-native-*/clip-0.mp4')):
            raise AssertionError('cancel point expected after the first clip result')
        assert_fixture_integrity(root)

    # 4. Output quota: same op with a 1 KiB ceiling terminates the confined encoder.
    def png(width, height, color):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
        pixels = (b'\x00' + bytes(color) * width) * height
        return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))
    frames = [png(960, 540, (40, 20, 80))] * 12
    try:
        broker.encode_png_clip(frames, 24, ffmpeg, output_limit=1024)
        raise AssertionError('output quota was not enforced')
    except RuntimeError as error:
        if 'runtime limit' not in str(error):
            raise
        print('quota negative: encoder terminated at the 1 KiB ceiling ->', error)
    try:
        broker.concat_clips([b'x' * (broker.CLIP_FRAME_LIMIT + 1)], 24, 12, ffmpeg)
        raise AssertionError('concat input bound was not enforced')
    except ValueError:
        print('quota negative: oversized clip blob rejected before confinement')

    # 5. Private-path and template refusal inside confinement (delegate fail-closed).
    with tempfile.TemporaryDirectory(prefix='glint-owned-worker-abuse-') as tmp:
        root = pathlib.Path(tmp)
        stage, work = root / 'dependency-view', root / 'work'
        private = root / 'private'
        private.write_text('PRIVATE_SENTINEL', encoding='utf8')
        delegate = root / 'confined-media.mjs'
        delegate.write_text(DELEGATE_SOURCE, encoding='utf8')

        def prepare(sid):
            worker.create_owned_directory(stage, sid)
            worker.create_owned_directory(work, sid, writable=True)
            shutil.copy2(delegate, stage / 'confined-media.mjs')
            (stage / 'abuse.mjs').write_text(ABUSE_SOURCE, encoding='utf8')

        env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root), 'TEMP': str(work), 'TMP': str(work),
               'GLINT_WORK': str(work), 'PATH': str(stage), 'GLINT_CHECK_PRIVATE': str(private),
               'GLINT_CHECK_SIBLING': str(root / 'sibling-sentinel')}
        source, output = root / 'unused-input', root / 'abuse-out'
        source.write_bytes(b'')
        output.write_bytes(b'')
        code, _ = handle.run(None, source, output, executable=node,
            arguments=['--preserve-symlinks', '--preserve-symlinks-main', str(stage / 'abuse.mjs')],
            environment=env, prepare_profile=prepare, deadline_ms=30000)
        if code != 0:
            raise AssertionError(f'abuse probe exited {code}')
        verdicts = json.loads(output.read_text(encoding='utf8').splitlines()[-1])['abuse']
        print('abuse verdicts:', json.dumps(verdicts, ensure_ascii=False))
        for name in ('privateOutput', 'siblingOutput', 'nonFfmpeg', 'unmatchedTemplate'):
            if verdicts.get(name) != 'refused':
                raise AssertionError(f'{name} was not refused: {verdicts.get(name)}')
        if private.read_text(encoding='utf8') != 'PRIVATE_SENTINEL' or (root / 'sibling-sentinel').exists():
            raise AssertionError('private fixture touched during abuse run')
        print('private path and template refusals verified inside confinement')

    print('Prototype only: broker-delegated confined render is not a production '
          'sandbox; Web html/three rendering stays rejected.')


if __name__ == '__main__':
    main()
