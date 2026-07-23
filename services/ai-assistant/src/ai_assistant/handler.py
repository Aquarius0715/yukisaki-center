from __future__ import annotations

import json
import logging
from typing import Any

from .bedrock import BedrockStructuredGenerator
from .service import AssistantService, InputError


LOGGER = logging.getLogger(__name__)
SERVICE: AssistantService | None = None

PATH_ACTIONS = {
    "/v1/ai/parse-route-request": "parse_route_request",
    "/v1/ai/explain-routes": "explain_routes",
    "/v1/ai/explain-danger-points": "explain_danger_points",
}


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        action = _action(event)
        if action not in {
            "parse_route_request",
            "explain_routes",
            "explain_danger_points",
        }:
            return _response(404, {"message": "Not found"})
        payload = _payload(event)
        service = _service()
        if action == "parse_route_request":
            result = service.parse_route_request(payload)
        elif action == "explain_routes":
            result = service.explain_routes(payload)
        elif action == "explain_danger_points":
            result = service.explain_danger_points(payload)
        LOGGER.info("AI assistant request completed", extra={"action": action})
        return _response(200, result)
    except (InputError, json.JSONDecodeError, TypeError) as exc:
        return _response(400, {"message": str(exc)})


def _service() -> AssistantService:
    global SERVICE
    if SERVICE is None:
        SERVICE = AssistantService(BedrockStructuredGenerator())
    return SERVICE


def _action(event: dict[str, Any]) -> str | None:
    if isinstance(event.get("action"), str):
        return event["action"]
    path = event.get("rawPath") or event.get("requestContext", {}).get("http", {}).get("path")
    return PATH_ACTIONS.get(path)


def _payload(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if body is None:
        return event.get("payload", event)
    if isinstance(body, str):
        parsed = json.loads(body)
    else:
        parsed = body
    if not isinstance(parsed, dict):
        raise InputError("request body must be a JSON object")
    return parsed


def _response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
    }
