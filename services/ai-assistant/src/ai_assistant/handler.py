from __future__ import annotations

from typing import Any

from .service import explain_route, extract_conditions


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    conditions = extract_conditions(event["text"])
    response: dict[str, Any] = {"conditions": conditions}
    if "route" in event:
        response["explanation"] = explain_route(event["route"])
    return response
