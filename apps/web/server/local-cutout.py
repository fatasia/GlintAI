"""Offline U²-Net inference; bounded image on stdin, transparent PNG on stdout."""
import io, os, sys, warnings
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 4_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
if not raw or len(raw) > 4 * 1024 * 1024:
    raise ValueError("invalid input size")
image = Image.open(io.BytesIO(raw))
if image.format not in ("PNG", "JPEG", "WEBP") or image.width * image.height > 4_000_000:
    raise ValueError("invalid image")
image = ImageOps.exif_transpose(image).convert("RGBA")
rgb = image.convert("RGB").resize((320, 320), Image.Resampling.BILINEAR)
tensor = np.asarray(rgb, dtype=np.float32) / 255.0
tensor = (tensor - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
tensor = np.transpose(tensor, (2, 0, 1))[None, ...]
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
session = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])
prediction = session.run(None, {session.get_inputs()[0].name: tensor})[0]
if prediction.shape != (1, 1, 320, 320) or not np.isfinite(prediction).all():
    raise ValueError("unexpected model output")
mask = prediction[0, 0]
lo, hi = float(mask.min()), float(mask.max())
if hi - lo < 1e-8:
    raise ValueError("empty model output")
mask = Image.fromarray(np.uint8(np.clip((mask - lo) / (hi - lo) * 255, 0, 255)), mode="L").resize(image.size, Image.Resampling.LANCZOS)
alpha = np.asarray(image.getchannel("A"), dtype=np.uint16)
predicted = np.asarray(mask, dtype=np.uint16)
image.putalpha(Image.fromarray(((alpha * predicted + 127) // 255).astype(np.uint8), mode="L"))
out = io.BytesIO()
image.save(out, format="PNG")
sys.stdout.buffer.write(out.getvalue())
