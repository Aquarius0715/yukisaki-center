from __future__ import annotations

from typing import Any


CONDITION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "origin_query",
        "destination_query",
        "via_queries",
        "priority",
        "avoid_conditions",
        "prefer_conditions",
        "driver_experience",
        "missing_fields",
        "needs_confirmation",
    ],
    "properties": {
        "origin_query": {"type": ["string", "null"]},
        "destination_query": {"type": ["string", "null"]},
        "via_queries": {"type": "array", "items": {"type": "string"}},
        "priority": {
            "type": "string",
            "enum": ["time", "balanced", "safety"],
        },
        "avoid_conditions": {
            "type": "array",
            "items": {
                "type": "string",
                "enum": ["steep_slope", "bridge", "narrow_road", "unplowed_road"],
            },
        },
        "prefer_conditions": {
            "type": "array",
            "items": {
                "type": "string",
                "enum": ["snow_pipe", "recently_plowed", "major_road"],
            },
        },
        "driver_experience": {
            "type": "string",
            "enum": ["beginner", "normal", "experienced", "unknown"],
        },
        "missing_fields": {
            "type": "array",
            "items": {"type": "string", "enum": ["origin", "destination"]},
        },
        "needs_confirmation": {"type": "boolean"},
    },
}


ROUTE_EXPLANATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["recommended_route_id", "recommendation_reason", "routes"],
    "properties": {
        "recommended_route_id": {"type": "string"},
        "recommendation_reason": {"type": "string"},
        "routes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["route_id", "summary", "advantages", "cautions"],
                "properties": {
                    "route_id": {"type": "string"},
                    "summary": {"type": "string"},
                    "advantages": {"type": "array", "items": {"type": "string"}},
                    "cautions": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
}


DANGER_EXPLANATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["hazards"],
    "properties": {
        "hazards": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["hazard_id", "explanation", "cautions"],
                "properties": {
                    "hazard_id": {"type": "string"},
                    "explanation": {"type": "string"},
                    "cautions": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
}
