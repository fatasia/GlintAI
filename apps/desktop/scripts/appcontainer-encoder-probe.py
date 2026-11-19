"""MOTION-09: direct, separately confined FFmpeg experiment; never enables Web.

Run on Windows with Python, Node-independent FFmpeg and ffprobe on PATH.
All fixtures, profiles, processes and directories belong to this invocation.
This does not implement a broker protocol or a production renderer sandbox.
"""
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

if os.name != 'nt':
    raise SystemExit('Windows only')

spec = importlib.util.spec_from_file_location('worker_probe', pathlib.Path(__file__).with_name('appcontainer-worker-probe.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
p = worker.p


def main():
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not ffmpeg or not ffprobe:
        raise RuntimeError('ffmpeg and ffprobe must be on PATH')
    with tempfile.TemporaryDirectory(prefix='glint-owned-encoder-') as tmp:
        root = pathlib.Path(tmp)
        stage, work = root / 'stage', root / 'work'
        source, output = root / 'input.raw', root / 'output.mp4'
        # 16x16 RGB24, 4 deterministic frames, passed via inherited stdin only.
        frame = bytes([240, 20, 80]) * (16 * 16)
        source.write_bytes(frame * 4)
        output.write_bytes(b'')
        executable = stage / 'ffmpeg.exe'

        def prepare(sid):
            worker.create_owned_directory(stage, sid)
            worker.create_owned_directory(work, sid, writable=True)
            shutil.copy2(ffmpeg, executable)

        env = {'SystemRoot': os.environ['SystemRoot'], 'LOCALAPPDATA': str(root),
               'TEMP': str(work), 'TMP': str(work), 'PATH': str(stage)}
        args = ['-hide_banner', '-loglevel', 'quiet', '-f', 'rawvideo', '-pixel_format', 'rgb24',
                '-video_size', '16x16', '-framerate', '4', '-i', 'pipe:0', '-frames:v', '4',
                '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']
        code, elapsed = p.run(None, source, output, executable=executable, arguments=args,
                              environment=env, prepare_profile=prepare,
                              memory_limit=512 * 1024 * 1024, cpu_ms=10000, deadline_ms=15000)
        print(f'direct confined encoder exit={code} elapsed={elapsed:.2f}s bytes={output.stat().st_size}')
        if code != 0:
            raise RuntimeError('direct confined encoder failed; no render success claimed')
        result = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0',
                                 '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
                                 '-count_frames', '-of', 'json', str(output)],
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise RuntimeError('ffprobe rejected encoded output: ' + result.stderr[-1000:])
        streams = json.loads(result.stdout).get('streams', [])
        if not streams or any(streams[0].get(k) != v for k, v in
                              {'codec_name': 'mpeg4', 'width': 16, 'height': 16, 'nb_read_frames': '4'}.items()):
            raise AssertionError('unexpected encoded stream: ' + result.stdout)
        print('ffprobe verified:', json.dumps(streams[0]))
        # Profile and temporary stage are destroyed between invocations; recreate
        # them per run, rather than modifying ACLs on pre-existing objects.
        shutil.rmtree(stage)
        shutil.rmtree(work)
        output.write_bytes(b'')
        bad_args = args.copy()
        bad_args[bad_args.index('mpeg4')] = 'glint_nonexistent_codec'
        bad_code, _ = p.run(None, source, output, executable=executable, arguments=bad_args,
                            environment=env, prepare_profile=prepare,
                            memory_limit=512 * 1024 * 1024, cpu_ms=10000, deadline_ms=15000)
        print(f'invalid codec exit={bad_code} bytes={output.stat().st_size}')
        if bad_code == 0:
            raise AssertionError('invalid codec unexpectedly succeeded')
        if source.read_bytes() != frame * 4:
            raise AssertionError('input fixture modified')
        shutil.rmtree(stage)
        shutil.rmtree(work)
        output.write_bytes(b'')
        try:
            p.run(None, source, output, executable=executable,
                  arguments=['-hide_banner', '-loglevel', 'quiet', '-f', 'lavfi', '-i',
                             'color=size=16x16:rate=1', '-f', 'null', '-'],
                  environment=env, prepare_profile=prepare,
                  memory_limit=512 * 1024 * 1024, cpu_ms=10000, deadline_ms=500)
        except TimeoutError:
            print('wall deadline: confined encoder terminated')
        else:
            raise AssertionError('unbounded encoder did not reach its wall deadline')
        print('Prototype only: no worker-to-broker protocol, browser, queue isolation, network or hostile-input proof.')


if __name__ == '__main__':
    main()
