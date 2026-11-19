"""MOTION-09 bounded encoder broker experiment; NOT a production sandbox.

No service, caller-supplied paths, command lines, codecs or filters. All files,
profiles and processes belong to this invocation. Whitelist render ops
(encode_png_clip, concat_clips) run FFmpeg in a second disposable confinement
with fixed argv templates and runtime output ceilings. This still does not cover
the worker's stitching-overlap or audio operations and enforces no temporary-disk
quota. It does not enable Web rendering.
"""
import ctypes
import hmac
import importlib.util
import msvcrt
import os
import pathlib
import shutil
import struct
import tempfile
import time

if os.name != 'nt':
    raise SystemExit('Windows only')

spec = importlib.util.spec_from_file_location('worker_probe', pathlib.Path(__file__).with_name('appcontainer-worker-probe.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

MAX_INPUT = 4 * 1024 * 1024
MAX_OUTPUT = 16 * 1024 * 1024
MAX_FRAMES = 30

# Prototype transport uses inherited anonymous pipes; it is not a service and
# does not constrain temporary disk. It must not enable Web.
IPC_VERSION = 1
IPC_AUTH, IPC_BEGIN, IPC_FRAME, IPC_FINISH = 1, 2, 3, 4
IPC_HEADER = struct.Struct('!BBII')  # version, operation, sequence, body length
IPC_TOKEN_BYTES = 32
IPC_FRAME_BYTES = 1024 * 1024
IPC_DEADLINE_SECONDS = 15

# Confined render-op bounds. One frame or one clip blob travels per contract
# frame, so both are capped at the wire frame size. These cover the bounded
# charts experiment only; production media would need renegotiated quotas.
CLIP_FRAME_LIMIT = IPC_FRAME_BYTES
CLIP_COUNT_LIMIT = MAX_FRAMES
ENCODE_INPUT_LIMIT = 64 * 1024 * 1024
CONTAINER_INPUT_LIMIT = 16 * 1024 * 1024
CLIP_OUTPUT_LIMIT = MAX_OUTPUT
ENCODE_PRESETS = ('veryfast', 'medium')
ENCODE_CRFS = (20, 24)


class ContractError(ValueError):
    pass


class SingleJobContract:
    """Fail-closed protocol model; the trusted transport must enforce its limits.

    Messages are ordered AUTH(token), BEGIN(frames,fps), FRAME*, FINISH.
    Integers use network byte order. One outstanding frame is allowed; a trusted
    consumer must acknowledge it before the next message. Neither commands nor
    paths are expressible. A contract instance is permanently spent after any
    failure or completion. Payload ownership is left with the caller.
    """
    def __init__(self, token, clock=time.monotonic):
        if type(token) is not bytes or len(token) != IPC_TOKEN_BYTES:
            raise ValueError('expected a 32-byte capability')
        self._token = token
        self._clock = clock
        self.deadline = clock() + IPC_DEADLINE_SECONDS
        self.state = 'auth'
        self.frames = 0
        self.fps = 0
        self.received = 0
        self.total_bytes = 0
        self.pending = False

    def _check_time(self):
        if self._clock() >= self.deadline:
            raise ContractError('deadline exceeded')

    def accept(self, header, body):
        try:
            return self._accept(header, body)
        except Exception:
            self.state = 'failed'
            self._token = None
            raise

    def _accept(self, header, body):
        self._check_time()
        if self.state in ('failed', 'done') or self.pending:
            raise ContractError('job is closed or awaiting frame acknowledgement')
        if type(header) is not bytes or len(header) != IPC_HEADER.size:
            raise ContractError('invalid header')
        version, op, sequence, length = IPC_HEADER.unpack(header)
        # A real transport must enforce this before allocating/reading the body.
        if version != IPC_VERSION or length > IPC_FRAME_BYTES or type(body) is not bytes or len(body) != length:
            raise ContractError('invalid version or body length')
        if self.state == 'auth':
            if op != IPC_AUTH or sequence != 0 or length != IPC_TOKEN_BYTES or not hmac.compare_digest(body, self._token):
                raise ContractError('authentication failed')
            self._token = None
            self.state = 'begin'
            return 'authenticated'
        if self.state == 'begin':
            if op != IPC_BEGIN or sequence != 0 or length != 8:
                raise ContractError('invalid begin')
            frames, fps = struct.unpack('!II', body)
            if not 1 <= frames <= MAX_FRAMES or not 1 <= fps <= 30:
                raise ContractError('invalid frame count or rate')
            self.frames, self.fps, self.state = frames, fps, 'frames'
            return 'ready'
        if op == IPC_FRAME:
            if sequence != self.received or self.received >= self.frames or not body or self.total_bytes + length > MAX_INPUT:
                raise ContractError('invalid frame sequence or input limit')
            self.received += 1
            self.total_bytes += length
            self.pending = True
            return 'frame'
        if op == IPC_FINISH and sequence == self.frames and not body and self.received == self.frames:
            self.state = 'done'
            return 'finished'
        raise ContractError('invalid operation or incomplete job')

    def acknowledge_frame(self):
        try:
            self._check_time()
            if self.state != 'frames' or not self.pending:
                raise ContractError('no frame awaiting acknowledgement')
            self.pending = False
        except Exception:
            self.state = 'failed'
            self._token = None
            raise


def serve_pipe(read_fd, write_fd, token, on_frame, on_begin=None):
    """Serve exactly one prototype job over a private inherited pipe pair.

    The parent owns the endpoints and must close them after return or failure.
    No paths or commands travel over this channel. The consumer is trusted and
    must itself be time bounded; ACKs total at most MAX_FRAMES + 3 bytes.
    """
    job = SingleJobContract(token)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.PeekNamedPipe.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
                                     ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    kernel.PeekNamedPipe.restype = ctypes.c_int
    handle = msvcrt.get_osfhandle(read_fd)

    def read_exact(length):
        result = bytearray()
        while len(result) < length:
            job._check_time()
            available = ctypes.c_uint32()
            if not kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
                raise ContractError('pipe closed or unavailable')
            if not available.value:
                time.sleep(min(0.01, max(0, job.deadline - time.monotonic())))
                continue
            chunk = os.read(read_fd, min(length - len(result), available.value))
            if not chunk:
                raise ContractError('unexpected end of pipe')
            result.extend(chunk)
        return bytes(result)

    try:
        while job.state != 'done':
            header = read_exact(IPC_HEADER.size)
            version, op, sequence, length = IPC_HEADER.unpack(header)
            if version != IPC_VERSION or length > IPC_FRAME_BYTES:
                raise ContractError('invalid version or body length')
            body = read_exact(length)
            event = job.accept(header, body)
            if event == 'ready' and on_begin is not None:
                on_begin(job.frames, job.fps)
            if event == 'frame':
                on_frame(sequence, body)
                job.acknowledge_frame()
            job._check_time()
            if os.write(write_fd, b'\x06') != 1:
                raise ContractError('pipe acknowledgement failed')
        return job.received
    except Exception:
        job.state = 'failed'
        job._token = None
        raise


def validate_request(request, data):
    if type(request) is not dict or set(request) != {'op', 'frames', 'fps'}:
        raise ValueError('expected exactly op, frames, fps')
    if request['op'] != 'encode_png_test':
        raise ValueError('unsupported operation')
    if type(request['frames']) is not int or not 1 <= request['frames'] <= MAX_FRAMES:
        raise ValueError('invalid frame count')
    if type(request['fps']) is not int or not 1 <= request['fps'] <= 30:
        raise ValueError('invalid frame rate')
    if type(data) is not bytes or not 0 < len(data) <= MAX_INPUT:
        raise ValueError('invalid input byte count')


def collect_output(read_fd, process, deadline, limit=MAX_OUTPUT):
    """Drain the encoder pipe with a hard byte ceiling while it is running."""
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.PeekNamedPipe.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
                                     ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    kernel.PeekNamedPipe.restype = ctypes.c_int
    result = bytearray()
    handle = msvcrt.get_osfhandle(read_fd)
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError('encoder output deadline exceeded')
        available = ctypes.c_uint32()
        if not kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
            if ctypes.get_last_error() == 109:  # ERROR_BROKEN_PIPE: all writers closed
                break
            raise OSError(ctypes.get_last_error(), 'encoder output pipe unavailable')
        if available.value:
            chunk = os.read(read_fd, min(available.value, 65536, limit + 1 - len(result)))
            result.extend(chunk)
            if len(result) > limit:
                raise RuntimeError('encoder output exceeds runtime limit')
        else:
            time.sleep(0.01)
    return bytes(result)


def _run_encoder(ffmpeg, arguments, prepare_staging, input_bytes=b'', output_limit=CLIP_OUTPUT_LIMIT,
                 cpu_ms=10000, deadline_ms=15000, memory_limit=512 * 1024 * 1024):
    """Run one fixed-argv FFmpeg inside its own disposable confinement.

    `arguments` is the argv template or a callable(work) resolved once the owned
    work directory path exists. Input bytes arrive through a private inherited
    pipe; output is drained from the encoder pipe with a runtime byte ceiling
    that terminates the encoder. prepare_staging(work) stages caller-owned blobs
    after the DACL exists; argv never contains caller paths.
    """
    if not ffmpeg:
        raise RuntimeError('FFmpeg unavailable')
    if type(output_limit) is not int or not 0 < output_limit <= CLIP_OUTPUT_LIMIT:
        raise ValueError('invalid output limit')
    if type(input_bytes) is not bytes or len(input_bytes) > ENCODE_INPUT_LIMIT:
        raise ValueError('invalid encoder input byte count')
    with tempfile.TemporaryDirectory(prefix='glint-owned-broker-') as tmp:
        root = pathlib.Path(tmp)
        stage, work = root / 'stage', root / 'work'
        source = root / 'input'
        source.write_bytes(input_bytes)
        executable = stage / 'ffmpeg.exe'
        argv = arguments(work) if callable(arguments) else arguments

        def prepare(sid):
            worker.create_owned_directory(stage, sid)
            worker.create_owned_directory(work, sid, writable=True)
            shutil.copy2(ffmpeg, executable)
            prepare_staging(work)

        env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root),
               'TEMP': str(work), 'TMP': str(work), 'PATH': str(stage)}
        result = []
        code, _ = worker.p.run(None, source, None, executable=executable,
                               arguments=argv, environment=env, prepare_profile=prepare,
                               memory_limit=memory_limit, cpu_ms=cpu_ms, deadline_ms=deadline_ms,
                               output_handler=lambda fd, proc, deadline: result.append(collect_output(fd, proc, deadline, output_limit)))
        if code != 0:
            raise RuntimeError(f'confined encoder failed with exit {code}')
        if not result or not result[0]:
            raise RuntimeError('empty encoder output')
        return result[0]


def _validate_blobs(blobs, count_limit, total_limit):
    if type(blobs) is not list or not blobs or len(blobs) > count_limit:
        raise ValueError('invalid blob count')
    total = 0
    for blob in blobs:
        if type(blob) is not bytes or not 0 < len(blob) <= CLIP_FRAME_LIMIT:
            raise ValueError('blob exceeds the per-frame wire limit')
        total += len(blob)
    if total > total_limit:
        raise ValueError('blobs exceed the job input limit')


def encode_png_clip(frames, fps, ffmpeg, *, crf=24, preset='veryfast', output_limit=CLIP_OUTPUT_LIMIT):
    """Encode buffered PNG frames into one H.264 clip with the renderer's template.

    frames are PNG byte blobs already received over the contract pipe; no paths
    or commands are accepted and the argv template is fixed. Container flags use
    the fragmented form because the encoder output is a pipe, not a seekable file.
    """
    _validate_blobs(frames, CLIP_COUNT_LIMIT, ENCODE_INPUT_LIMIT)
    if type(fps) is not int or not 1 <= fps <= 30:
        raise ValueError('invalid frame rate')
    if crf not in ENCODE_CRFS or preset not in ENCODE_PRESETS:
        raise ValueError('encoding preset outside the whitelist')
    arguments = ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', str(fps), '-i', 'pipe:0',
                 '-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-pix_fmt', 'yuv420p',
                 '-movflags', '+frag_keyframe+empty_moov', '-an', '-f', 'mp4', 'pipe:1']
    return _run_encoder(ffmpeg, arguments, lambda work: None, b''.join(frames), output_limit)


def concat_clips(clips, fps, duration_frames, ffmpeg, *, output_limit=CLIP_OUTPUT_LIMIT):
    """Copy-concatenate broker-encoded clips with the renderer's container template.

    The clip blobs are restaged inside the confined work directory under fixed
    names and the concat list is built by this process; the worker never supplies
    paths. `-t` mirrors the renderer's duration-in-frames over fps expression.
    """
    _validate_blobs(clips, CLIP_COUNT_LIMIT, CONTAINER_INPUT_LIMIT)
    if type(fps) is not int or not 1 <= fps <= 30:
        raise ValueError('invalid frame rate')
    if type(duration_frames) is not int or duration_frames < 1:
        raise ValueError('invalid duration')

    def stage(work):
        for index, blob in enumerate(clips):
            (work / f'clip-{index}.mp4').write_bytes(blob)
        listing = '\n'.join(f"file '{(work / f'clip-{index}.mp4').as_posix()}'" for index in range(len(clips)))
        (work / 'list.txt').write_text(listing + '\n', encoding='utf8')

    arguments = lambda work: ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(work / 'list.txt'),
                              '-map', '0:v:0', '-c:v', 'copy', '-movflags', '+frag_keyframe+empty_moov',
                              '-t', str(duration_frames / fps), '-f', 'mp4', 'pipe:1']
    return _run_encoder(ffmpeg, arguments, stage, b'', output_limit)


def encode(request, data, ffmpeg, output_limit=MAX_OUTPUT):
    """Run a fixed encoder on in-memory data and return bytes, never paths.

    Input is a private parent-owned handle; output is drained through a pipe with
    a runtime byte limit. The caller must not treat this experiment as a service.
    """
    validate_request(request, data)
    arguments = ['-hide_banner', '-loglevel', 'quiet', '-f', 'image2pipe',
                 '-vcodec', 'png', '-framerate', str(request['fps']), '-i', 'pipe:0',
                 '-frames:v', str(request['frames']), '-vf', 'scale=16:16', '-an',
                 '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']
    result = _run_encoder(ffmpeg, arguments, lambda work: None, data, output_limit)
    if not result:
        raise RuntimeError('empty encoder output')
    return result
