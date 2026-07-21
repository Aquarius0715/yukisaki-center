"""AWS Lambda HTTP API v2 adapter."""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import Any
from urllib.parse import unquote

from .repository import PostgresMapRepository
from .service import MapQuery, MapService, RequestError

LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)
CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
}


@lru_cache(maxsize=1)
def _service() -> MapService:
    return MapService(PostgresMapRepository())


def _response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False, separators=(",", ":"), default=str),
    }


def handle(event: dict[str, Any], service: MapService) -> dict[str, Any]:
    request = event.get("requestContext", {}).get("http", {})
    method = request.get("method", "GET")
    path = request.get("path") or event.get("rawPath", "/")
    if method == "OPTIONS":
        return _response(204, {})
    if method != "GET":
        return _response(405, {"error": {"code": "method_not_allowed", "message": "GET only"}})
    if path == "/healthz":
        return _response(200, {"status": "ok"})
    try:
        query = MapQuery.parse(event.get("queryStringParameters"))
        if path == "/v1/road-segments":
            return _response(200, service.roads(query))
        if path.startswith("/v1/road-segments/"):
            segment_id = unquote(path.removeprefix("/v1/road-segments/"))
            if not segment_id or len(segment_id) > 200:
                raise RequestError("segment id is invalid")
            feature = service.road(segment_id)
            return _response(200, feature) if feature else _response(404, {"error": {"code": "not_found", "message": "road segment was not found"}})
        if path == "/v1/snowplows":
            return _response(200, service.snowplows())
        if path == "/v1/map/snapshot":
            return _response(200, service.snapshot(query))
        return _response(404, {"error": {"code": "not_found", "message": "route was not found"}})
    except RequestError as error:
        return _response(400, {"error": {"code": "invalid_request", "message": str(error)}})


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        return handle(event, _service())
    except Exception:
        LOGGER.exception("Map API request failed")
        return _response(503, {"error": {"code": "service_unavailable", "message": "map data is temporarily unavailable"}})
