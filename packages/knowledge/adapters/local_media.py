"""Opt-in local OCR/transcription. Reads the same bounded JSON protocol as commandSourceAdapter."""
import argparse,base64,contextlib,io,json,os,sys
from pathlib import Path
sys.stdin.reconfigure(encoding="utf-8",errors="strict")
sys.stdout.reconfigure(encoding="utf-8",errors="strict")
os.environ["HF_HUB_OFFLINE"]="1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"]="1"
os.environ["HF_HUB_DISABLE_TELEMETRY"]="1"
p=argparse.ArgumentParser();p.add_argument("--model");args=p.parse_args()
request=sys.stdin.read(15*1024*1024+1)
if len(request)>15*1024*1024:raise ValueError("Input too large")
x=json.loads(request);data=base64.b64decode(x['base64'],validate=True);ext=x['extension']
if len(data)>10*1024*1024:raise ValueError("Input exceeds 10 MiB")
with contextlib.redirect_stdout(sys.stderr):
 if ext in ('png','jpg','jpeg','webp','gif'):
  import numpy as np
  from PIL import Image
  from rapidocr_onnxruntime import RapidOCR
  Image.MAX_IMAGE_PIXELS=20_000_000
  image=Image.open(io.BytesIO(data))
  if image.width*image.height>20_000_000:raise ValueError("Image too large")
  pixels=np.array(image.convert('RGB'))[:,:,::-1].copy()
  engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1)
  rows,_=engine(pixels)
  text='\n'.join(row[1] for row in (rows or []) if row[2]>=0.5)
 elif ext in ('wav','mp3','mp4','m4a','mov','webm','ogg'):
  if not args.model or not Path(args.model).is_dir():raise ValueError("Local Whisper model is required")
  import av
  with av.open(io.BytesIO(data)) as media:
   if not media.streams.audio:raise ValueError("No audio stream")
   duration=media.duration/1_000_000 if media.duration is not None else None
   if duration is None or duration>600:raise ValueError("Audio must have a known duration of at most 10 minutes")
  from faster_whisper import WhisperModel
  model=WhisperModel(args.model,device='cpu',compute_type='int8',cpu_threads=4,num_workers=1,local_files_only=True)
  segments,info=model.transcribe(io.BytesIO(data),beam_size=5,condition_on_previous_text=False)
  text='\n'.join(f'[{s.start:.2f}–{s.end:.2f}] {s.text.strip()}' for s in segments)
 else:raise ValueError("Unsupported media extension")
if not text.strip():raise ValueError("No text recognized")
if len(text.encode('utf8'))>10*1024*1024:raise ValueError("Output too large")
sys.stdout.write(text)
