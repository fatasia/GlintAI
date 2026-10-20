"""Optional local content check, separate from perceptual listening or speaker identity."""
import argparse
import json
from pathlib import Path
import re
import time
import unicodedata

def tokens(text, language):
    text = unicodedata.normalize("NFKC", text).lower()
    text = "".join(c for c in text if c.isalnum() or c.isspace())
    return list(re.sub(r"\s", "", text)) if language == "zh" else text.split()

def distance(a, b):
    row = list(range(len(b) + 1))
    for i, left in enumerate(a):
        next_row = [i + 1]
        for j, right in enumerate(b):
            next_row.append(min(next_row[-1] + 1, row[j + 1] + 1, row[j] + (left != right)))
        row = next_row
    return row[-1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", required=True)
    parser.add_argument("--model", required=True, help="Existing faster-whisper local model directory")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    from faster_whisper import WhisperModel
    suite = json.loads(Path(args.suite).read_text(encoding="utf-8"))
    if not 1 <= len(suite["audio"]) <= 20: raise ValueError("Expected 1..20 audio cases")
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
    results = []
    for item in suite["audio"]:
        if Path(item["file"]).stat().st_size > 32 * 1024 * 1024: raise ValueError("Audio exceeds 32 MiB")
        language = item["language"]
        started = time.perf_counter()
        # Prompt specifies script only, never the expected transcript.
        segments, _ = model.transcribe(item["file"], language=language, initial_prompt="以下是简体中文普通话。" if language == "zh" else None, beam_size=5, condition_on_previous_text=False)
        actual = "".join(segment.text for segment in segments)
        expected_tokens, actual_tokens = tokens(item["text"], language), tokens(actual, language)
        edits = distance(expected_tokens, actual_tokens)
        rate = edits / max(1, len(expected_tokens))
        threshold = 0.10 if language == "zh" else 0.15
        result = {**item, "transcript": actual, "metric": "CER" if language == "zh" else "WER", "edits": edits, "referenceTokens": len(expected_tokens), "errorRate": rate, "threshold": threshold, "elapsedMs": (time.perf_counter() - started) * 1000, "passed": rate <= threshold and bool(actual_tokens)}
        results.append(result)
        print(f"[voice-asr] {Path(item['file']).name}: {result['metric']}={rate:.3f}; passed={result['passed']}", flush=True)
    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": str(Path(args.model).resolve()), "methodology": "Local Whisper, CPU int8, beam 5, explicit language; Chinese script-only prompt. Punctuation/case/width normalized; no transcript prompt, homophone, digit or traditional-script substitutions. Errors mix ASR and TTS errors, not a perceptual score.", "cases": results, "humanEvaluation": "not performed (automatic checks requested)", "passed": all(item["passed"] for item in results)}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report["passed"] else 1

if __name__ == "__main__": raise SystemExit(main())
