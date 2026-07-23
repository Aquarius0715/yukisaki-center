"""Validated public request models for route planning."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .config import COST_PROFILES, DEMO_REFERENCE_TIME, NAGAOKA_BOUNDS


class RequestValidationError(ValueError):
    pass


@dataclass(frozen=True)
class Point:
    latitude: float
    longitude: float

    @classmethod
    def parse(cls, value: Any, field: str) -> "Point":
        if not isinstance(value, dict):
            raise RequestValidationError(f"{field} must be an object")
        try:
            latitude = float(value["latitude"])
            longitude = float(value["longitude"])
        except (KeyError, TypeError, ValueError) as error:
            raise RequestValidationError(f"{field} must contain numeric latitude and longitude") from error
        west, south, east, north = NAGAOKA_BOUNDS
        if not south <= latitude <= north or not west <= longitude <= east:
            raise RequestValidationError(f"{field} is outside Nagaoka City bounds")
        return cls(latitude=latitude, longitude=longitude)


@dataclass(frozen=True)
class RouteOptions:
    avoid: tuple[str, ...] = ()
    prefer: tuple[str, ...] = ()
    max_detour_minutes: int = 10

    @classmethod
    def parse(cls, value: Any) -> "RouteOptions":
        if value is None:
            return cls()
        if not isinstance(value, dict):
            raise RequestValidationError("options must be an object")
        avoid = value.get("avoid", [])
        prefer = value.get("prefer", [])
        if not isinstance(avoid, list) or not all(isinstance(item, str) for item in avoid):
            raise RequestValidationError("options.avoid must be a string array")
        if not isinstance(prefer, list) or not all(isinstance(item, str) for item in prefer):
            raise RequestValidationError("options.prefer must be a string array")
        allowed_avoid = {"steep_road", "bridge"}
        allowed_prefer = {"main_road", "recently_plowed"}
        if set(avoid) - allowed_avoid:
            raise RequestValidationError("options.avoid contains an unsupported value")
        if set(prefer) - allowed_prefer:
            raise RequestValidationError("options.prefer contains an unsupported value")
        max_detour = value.get("max_detour_minutes", 10)
        if not isinstance(max_detour, int) or not 0 <= max_detour <= 30:
            raise RequestValidationError("options.max_detour_minutes must be an integer from 0 to 30")
        return cls(tuple(dict.fromkeys(avoid)), tuple(dict.fromkeys(prefer)), max_detour)


@dataclass(frozen=True)
class RouteRequest:
    origin: Point
    destination: Point
    mode: str
    options: RouteOptions
    reference_time: datetime

    @classmethod
    def parse(cls, value: Any) -> "RouteRequest":
        if not isinstance(value, dict):
            raise RequestValidationError("request body must be an object")
        mode = value.get("mode", "balanced")
        if mode not in COST_PROFILES:
            raise RequestValidationError("mode is unsupported")
        reference_text = value.get("reference_time", DEMO_REFERENCE_TIME)
        if reference_text != DEMO_REFERENCE_TIME:
            raise RequestValidationError("reference_time must match the fixed demo time")
        reference_time = datetime.fromisoformat(reference_text)
        origin = Point.parse(value.get("origin"), "origin")
        destination = Point.parse(value.get("destination"), "destination")
        if origin == destination:
            raise RequestValidationError("origin and destination must be different")
        return cls(origin, destination, mode, RouteOptions.parse(value.get("options")), reference_time)

