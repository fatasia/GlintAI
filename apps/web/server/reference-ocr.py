"""Offline per-frame OCR. Input/output are bounded JSON, never instructions."""
import base64, contextlib, io, json, os, sys
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
if len(raw) > 16 * 1024 * 1024:
    raise ValueError("input too large")
frames = json.loads(raw)["frames"]
if not isinstance(frames, list) or len(frames) > 12:
    raise ValueError("invalid frame count")
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR
    Image.MAX_IMAGE_PIXELS = 2_000_000
    engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
    samples = []
    for encoded in frames:
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > 2 * 1024 * 1024:
            raise ValueError("invalid frame")
        img = Image.open(io.BytesIO(data))
        if img.width * img.height > 2_000_000:
            raise ValueError("frame too large")
        rows, _ = engine(np.array(img.convert("RGB"))[:, :, ::-1].copy())
        lines = []
        for row in (rows or [])[:100]:
            text = str(row[1]).strip()[:500]
            score = float(row[2])
            if text and 0 <= score <= 1:
                lines.append({"text": text, "score": score})
        samples.append({"width": img.width, "height": img.height, "lines": lines})
out = json.dumps({"samples": samples}, ensure_ascii=False).encode("utf-8")
if len(out) > 128 * 1024:
    raise ValueError("output too large")
sys.stdout.buffer.write(out)
