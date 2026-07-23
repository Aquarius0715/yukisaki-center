"""Public HTTP adapter for Apple Maps place search."""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import Any

from .places import (
    AppleMapsClient,
    AppleMapsTokenProvider,
    PlaceProviderError,
    PlaceQuery,
    PlaceRequestError,
    PlaceSearchService,
    load_apple_maps_secret,
)

LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)
HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=60",
}


@lru_cache(maxsize=1)
def _service() -> PlaceSearchService:
    return PlaceSearchService(
        AppleMapsClient(AppleMapsTokenProvider(load_apple_maps_secret))
    )


def _response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": HEADERS,
        "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
    }


def handle(event: dict[str, Any], service: PlaceSearchService) -> dict[str, Any]:
    request = event.get("requestContext", {}).get("http", {})
    method = request.get("method", "GET")
    path = request.get("path") or event.get("rawPath", "/")
    if method == "OPTIONS":
        return _response(204, {})
    if method != "GET":
        return _response(
            405, {"error": {"code": "method_not_allowed", "message": "GET only"}}
        )
    try:
        query = PlaceQuery.parse(event.get("queryStringParameters"))
        if path == "/v1/places/search":
            return _response(200, service.search(query))
        if path == "/v1/places/autocomplete":
            return _response(200, service.autocomplete(query))
        return _response(
            404, {"error": {"code": "not_found", "message": "route was not found"}}
        )
    except PlaceRequestError as error:
        return _response(
            400, {"error": {"code": "invalid_request", "message": str(error)}}
        )
    except PlaceProviderError as error:
        return _response(
            error.status,
            {
                "error": {
                    "code": error.code,
                    "message": "place search is temporarily unavailable",
                }
            },
        )


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        return handle(event, _service())
    except Exception:
        LOGGER.exception("Place search request failed")
        return _response(
            503,
            {
                "error": {
                    "code": "place_search_unavailable",
                    "message": "place search is temporarily unavailable",
                }
            },
        )
