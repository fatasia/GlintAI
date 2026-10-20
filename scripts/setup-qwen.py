"""Explicit optional model download. Does not install Python packages or use account tokens."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-dir", required=True)
parser.add_argument("--source", choices=["huggingface", "modelscope"], default="huggingface")
parser.add_argument("--official-demo", action="store_true", help="Download the reference clip linked by the official model card")
args = parser.parse_args()
root = Path(args.runtime_dir).resolve()
repo = Path(__file__).resolve().parent.parent
if root == repo or repo in root.parents:
    parser.error("Keep model weights outside the source repository")
root.mkdir(parents=True, exist_ok=True)
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
patterns = ["*.json", "*.safetensors", "*.txt", "*.model", "*.npz", "*.tiktoken"]
if args.source == "modelscope":
    anonymous = root / "anonymous-home"
    anonymous.mkdir(exist_ok=True)
    os.environ["HOME"] = os.environ["USERPROFILE"] = str(anonymous)
    os.environ["MODELSCOPE_CACHE"] = str(root / "modelscope-cache")
    import torch  # Initialize native DLLs before ModelScope's optional imports on Windows.
    from http.cookiejar import CookieJar
    from modelscope import snapshot_download
    model = snapshot_download(
        "Qwen/Qwen3-TTS-12Hz-0.6B-Base", token="", cookies=CookieJar(),
        local_dir=str(root / "model"), max_workers=2, allow_patterns=patterns,
    )
else:
    from huggingface_hub import snapshot_download
    model = snapshot_download(
        "Qwen/Qwen3-TTS-12Hz-0.6B-Base", token=False,
        local_dir=str(root / "model"), max_workers=2, allow_patterns=patterns,
    )
if args.official_demo:
    url = "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-TTS-Repo/clone.wav"
    with urllib.request.urlopen(url, timeout=30) as response:
        audio = response.read(10 * 1024 * 1024 + 1)
    if len(audio) > 10 * 1024 * 1024 or audio[:4] != b"RIFF":
        raise ValueError("Unexpected reference audio")
    (root / "official-demo.wav").write_bytes(audio)
    (root / "official-demo.json").write_text(json.dumps({"source": url, "sha256": hashlib.sha256(audio).hexdigest()}, indent=2), encoding="utf8")
print("Local model directory:", model)
