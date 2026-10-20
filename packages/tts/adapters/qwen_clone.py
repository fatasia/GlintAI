"""Optional local Qwen3-TTS worker. Models and reference audio must already be local."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import time

# The JSONL protocol is UTF-8 even when Windows uses a legacy console code page.
sys.stdin.reconfigure(encoding="utf-8", errors="strict")
sys.stdout.reconfigure(encoding="utf-8", errors="strict")

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

def main():
    config = json.loads(sys.stdin.readline())
    model_dir = Path(config["modelDir"])
    reference = Path(config["referenceAudio"])
    if not model_dir.is_dir() or not reference.is_file():
        raise ValueError("Local model and reference files are required")
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import soundfile as sf
        from qwen_tts import Qwen3TTSModel
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        model = Qwen3TTSModel.from_pretrained(
            str(model_dir), device_map=device,
            dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
            attn_implementation="sdpa", local_files_only=True,
        )
        ref_text = config.get("referenceText") or None
        prompt = model.create_voice_clone_prompt(
            ref_audio=str(reference), ref_text=ref_text,
            x_vector_only_mode=not bool(ref_text),
        )
    emit({"type": "ready", "device": device})
    for line in sys.stdin:
        request = json.loads(line)
        text = request["text"]
        if not isinstance(text, str) or not text.strip() or len(text) > 10000:
            raise ValueError("Invalid narration")
        with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
            if device.startswith("cuda"):
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
            started = time.perf_counter()
            wavs, sr = model.generate_voice_clone(
                text=text, language=request.get("language", "Auto"),
                voice_clone_prompt=prompt, max_new_tokens=2048,
            )
            if device.startswith("cuda"):
                torch.cuda.synchronize()
            diagnostics = {"inferenceMs": (time.perf_counter()-started)*1000,
                "peakAllocatedMiB": torch.cuda.max_memory_allocated()/1048576 if device.startswith("cuda") else 0,
                "peakReservedMiB": torch.cuda.max_memory_reserved()/1048576 if device.startswith("cuda") else 0}
            if config.get("measureQuality"):
                generated_prompt = model.create_voice_clone_prompt(ref_audio=(wavs[0],sr), x_vector_only_mode=True)
                score = torch.nn.functional.cosine_similarity(prompt[0].ref_spk_embedding.reshape(1,-1).float(), generated_prompt[0].ref_spk_embedding.reshape(1,-1).float()).item()
                diagnostics["speakerEmbeddingCosine"] = score
            buffer = io.BytesIO()
            sf.write(buffer, wavs[0], sr, format="WAV", subtype="PCM_16")
        audio = buffer.getvalue()
        if len(audio) > 32 * 1024 * 1024:
            raise ValueError("Audio output too large")
        emit({"id": request["id"], "audio": base64.b64encode(audio).decode("ascii"), "diagnostics": diagnostics})

if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"type": "error", "error": "Local Qwen worker failed. Check runtime, model files and reference audio."})
        raise
