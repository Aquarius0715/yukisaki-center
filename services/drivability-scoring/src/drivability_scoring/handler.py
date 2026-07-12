from __future__ import annotations

from typing import Any

from .engine import score_segment


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    segments = event.get("segments", [])
    if not isinstance(segments, list) or not segments:
        raise ValueError("segments must be a non-empty list")
    return {"status": "scored", "results": [score_segment(item) for item in segments]}
