"""AWS Lambda HTTP adapter for POST /v1/routes."""

from __future__ import annotations

import json
import logging
from typing import Any

from .models import RequestValidationError
from .repository import (
    GraphUnavailableError,
    PointNotOnRoadError,
    RouteNotFoundError,
)
from .service import RoutePlanningService

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)
SERVICE = RoutePlanningService()
MAX_BODY_BYTES = 16_384


def response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
    }


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
        if method != "POST":
            return response(405, {"error": "method_not_allowed"})
        raw_body = event.get("body") or "{}"
        if len(raw_body.encode()) > MAX_BODY_BYTES:
            return response(413, {"error": "request_too_large"})
        payload = json.loads(raw_body)
        result = SERVICE.plan(payload)
        LOGGER.info(
            "route request completed request_id=%s graph_version=%s routes=%d",
            result["request_id"], result["graph_version"], len(result["routes"]),
        )
        return response(200, result)
    except (json.JSONDecodeError, RequestValidationError, PointNotOnRoadError) as error:
        return response(400, {"error": "invalid_request", "message": str(error)})
    except RouteNotFoundError as error:
        return response(404, {"error": "route_not_found", "message": str(error)})
    except GraphUnavailableError as error:
        return response(409, {"error": "route_data_unavailable", "message": str(error)})
    except Exception:
        LOGGER.exception("route planning failed")
        return response(503, {"error": "route_service_unavailable"})
