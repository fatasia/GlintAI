"""Third-party readback of Glint timeline exports via OpenTimelineIO.

DELIVER-04 第三方兼容性证据:Glint 导出的 FCPXML/EDL 必须能被生态标准库
OpenTimelineIO 读回并得到一致的轨道、片段与时长。输出一行 JSON。
"""
import json
import sys

import opentimelineio as otio
from opentimelineio.opentime import to_seconds


def load_timeline(path: str, rate: int | None = None):
    # CMX3600 时码本身不带帧率;cmx_3600 适配器默认按 24fps 解析,Glint 的
    # 导出率由调用方显式传入,否则读回时长会被错误换算。
    loaded = otio.adapters.read_from_file(path, **({"rate": rate} if rate else {}))
    if isinstance(loaded, otio.schema.Timeline):
        return loaded
    for item in loaded:
        if isinstance(item, otio.schema.Timeline):
            return item
    raise SystemExit(f"no timeline found in {path}")


def summary(path: str, rate: int | None = None) -> dict:
    timeline = load_timeline(path, rate)
    clips = []
    for track in timeline.tracks:
        for child in track:
            if isinstance(child, otio.schema.Clip):
                clips.append({
                    "name": child.name,
                    "sourceSeconds": round(to_seconds(child.source_range.duration), 4) if child.source_range else None,
                })
    return {
        "name": timeline.name,
        "tracks": len(timeline.tracks),
        "clips": clips,
        "clipCount": len(clips),
        "durationSeconds": round(to_seconds(timeline.duration()), 4),
    }


def main() -> None:
    fcpxml, edl = sys.argv[1], sys.argv[2]
    fps = int(sys.argv[3]) if len(sys.argv) > 3 else None
    print(json.dumps({"fcpxml": summary(fcpxml), "edl": summary(edl, fps)}))


if __name__ == "__main__":
    main()
