from __future__ import annotations

from typing import Any

from .engine import find_route


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return {"status": "planned", "route": find_route(event["edges"], event["start"], event["goal"])}
