"""Explicit anonymous download for the optional local transcription adapter."""
import argparse,os
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--runtime-dir',required=True);args=p.parse_args()
root=Path(args.runtime_dir).resolve();repo=Path(__file__).resolve().parent.parent
if root==repo or repo in root.parents:p.error('Keep models outside the repository')
root.mkdir(parents=True,exist_ok=True)
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN']='1';os.environ['HF_HUB_DISABLE_TELEMETRY']='1';os.environ['HF_HUB_DISABLE_XET']='1'
from huggingface_hub import snapshot_download
snapshot_download('Systran/faster-whisper-tiny',token=False,local_dir=str(root/'whisper-tiny'),allow_patterns=['*.json','model.bin','vocabulary.txt'],max_workers=1)
print('Local Whisper model:',root/'whisper-tiny')
