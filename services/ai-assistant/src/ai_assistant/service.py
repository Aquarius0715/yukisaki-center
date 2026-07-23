from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from .prompts import (
    CONDITION_SYSTEM_PROMPT,
    DANGER_EXPLANATION_SYSTEM_PROMPT,
    ROUTE_EXPLANATION_SYSTEM_PROMPT,
)
from .schemas import CONDITION_SCHEMA, DANGER_EXPLANATION_SCHEMA, ROUTE_EXPLANATION_SCHEMA


MAX_TEXT_LENGTH = 1_000
MAX_PAYLOAD_BYTES = 64 * 1024
LOGGER = logging.getLogger(__name__)


class InputError(ValueError):
    pass


class StructuredGenerator(Protocol):
    model_id: str

    def generate(
        self,
        *,
        schema_name: str,
        schema: dict[str, Any],
        system_prompt: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]: ...


class AssistantService:
    def __init__(self, generator: StructuredGenerator) -> None:
        self.generator = generator

    def parse_route_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise InputError("text is required")
        if len(text) > MAX_TEXT_LENGTH:
            raise InputError(f"text must be {MAX_TEXT_LENGTH} characters or fewer")

        fallback = _fallback_conditions(text)
        result, fallback_used = self._generate_or_fallback(
            schema_name="route_conditions",
            schema=CONDITION_SCHEMA,
            system_prompt=CONDITION_SYSTEM_PROMPT,
            payload={"text": text},
            fallback=fallback,
            validator=_validate_conditions,
        )
        return self._response(result, fallback_used, is_simulated=False, data_timestamp=None)

    def explain_routes(self, payload: dict[str, Any]) -> dict[str, Any]:
        _validate_payload_size(payload)
        routes = payload.get("routes")
        recommended_route_id = payload.get("recommended_route_id")
        if not isinstance(routes, list) or not 1 <= len(routes) <= 3:
            raise InputError("routes must contain between 1 and 3 routes")
        route_ids = [_required_string(route, "route_id") for route in routes]
        if len(route_ids) != len(set(route_ids)):
            raise InputError("route_id must be unique")
        if recommended_route_id not in route_ids:
            raise InputError("recommended_route_id must identify an input route")
        data_timestamp, is_simulated = _evidence_metadata(payload)

        fallback = _fallback_route_explanation(payload)

        def validator(result: dict[str, Any]) -> bool:
            if set(result) != {"recommended_route_id", "recommendation_reason", "routes"}:
                return False
            if result.get("recommended_route_id") != recommended_route_id:
                return False
            if not isinstance(result.get("recommendation_reason"), str):
                return False
            output_routes = result.get("routes")
            if not isinstance(output_routes, list) or len(output_routes) != len(route_ids):
                return False
            if [item.get("route_id") for item in output_routes] != route_ids:
                return False
            return all(
                isinstance(item, dict)
                and set(item) == {"route_id", "summary", "advantages", "cautions"}
                and isinstance(item.get("summary"), str)
                and _is_string_list(item.get("advantages"))
                and _is_string_list(item.get("cautions"))
                for item in output_routes
            )

        result, fallback_used = self._generate_or_fallback(
            schema_name="route_explanations",
            schema=ROUTE_EXPLANATION_SCHEMA,
            system_prompt=ROUTE_EXPLANATION_SYSTEM_PROMPT,
            payload=payload,
            fallback=fallback,
            validator=validator,
        )
        return self._response(result, fallback_used, is_simulated, data_timestamp)

    def explain_danger_points(self, payload: dict[str, Any]) -> dict[str, Any]:
        _validate_payload_size(payload)
        hazards = payload.get("hazards")
        if not isinstance(hazards, list) or not 1 <= len(hazards) <= 20:
            raise InputError("hazards must contain between 1 and 20 items")
        hazard_ids = [_required_string(hazard, "hazard_id") for hazard in hazards]
        if len(hazard_ids) != len(set(hazard_ids)):
            raise InputError("hazard_id must be unique")
        data_timestamp, is_simulated = _evidence_metadata(payload)
        fallback = _fallback_danger_explanation(payload)

        def validator(result: dict[str, Any]) -> bool:
            if set(result) != {"hazards"}:
                return False
            output_hazards = result.get("hazards")
            if not isinstance(output_hazards, list) or len(output_hazards) != len(hazard_ids):
                return False
            if [item.get("hazard_id") for item in output_hazards] != hazard_ids:
                return False
            return all(
                isinstance(item, dict)
                and set(item) == {"hazard_id", "explanation", "cautions"}
                and isinstance(item.get("explanation"), str)
                and _is_string_list(item.get("cautions"))
                for item in output_hazards
            )

        result, fallback_used = self._generate_or_fallback(
            schema_name="danger_explanations",
            schema=DANGER_EXPLANATION_SCHEMA,
            system_prompt=DANGER_EXPLANATION_SYSTEM_PROMPT,
            payload=payload,
            fallback=fallback,
            validator=validator,
        )
        return self._response(result, fallback_used, is_simulated, data_timestamp)

    def _generate_or_fallback(
        self,
        *,
        schema_name: str,
        schema: dict[str, Any],
        system_prompt: str,
        payload: dict[str, Any],
        fallback: dict[str, Any],
        validator: Any,
    ) -> tuple[dict[str, Any], bool]:
        try:
            result = self.generator.generate(
                schema_name=schema_name,
                schema=schema,
                system_prompt=system_prompt,
                payload=payload,
            )
            if not validator(result):
                LOGGER.warning(
                    "Bedrock structured output failed local validation: schema=%s",
                    schema_name,
                )
                return fallback, True
            return result, False
        except Exception as exc:
            error = getattr(exc, "response", {}).get("Error", {})
            LOGGER.warning(
                "Bedrock structured generation failed: schema=%s error_type=%s error_code=%s error_message=%s",
                schema_name,
                type(exc).__name__,
                error.get("Code", "unknown"),
                error.get("Message", "not provided"),
            )
            return fallback, True

    def _response(
        self,
        result: dict[str, Any],
        fallback_used: bool,
        is_simulated: bool,
        data_timestamp: str | None,
    ) -> dict[str, Any]:
        return {
            "result": result,
            "metadata": {
                "model_id": self.generator.model_id,
                "fallback_used": fallback_used,
                "is_simulated": is_simulated,
                "data_timestamp": data_timestamp,
            },
        }


def _validate_conditions(result: dict[str, Any]) -> bool:
    required = set(CONDITION_SCHEMA["required"])
    if set(result) != required:
        return False
    nullable_places = (result.get("origin_query"), result.get("destination_query"))
    if not all(value is None or isinstance(value, str) for value in nullable_places):
        return False
    if not _is_string_list(result.get("via_queries")):
        return False
    if result.get("priority") not in {"time", "balanced", "safety"}:
        return False
    if not _is_allowed_list(
        result.get("avoid_conditions"),
        {"steep_slope", "bridge", "narrow_road", "unplowed_road"},
    ):
        return False
    if not _is_allowed_list(
        result.get("prefer_conditions"),
        {"snow_pipe", "recently_plowed", "major_road"},
    ):
        return False
    if result.get("driver_experience") not in {"beginner", "normal", "experienced", "unknown"}:
        return False
    if not _is_allowed_list(result.get("missing_fields"), {"origin", "destination"}):
        return False
    return isinstance(result.get("needs_confirmation"), bool)


def _fallback_conditions(text: str) -> dict[str, Any]:
    safety_words = ("安全", "雪道", "危険", "凍結")
    return {
        "origin_query": None,
        "destination_query": None,
        "via_queries": [],
        "priority": "safety" if any(word in text for word in safety_words) else "balanced",
        "avoid_conditions": [],
        "prefer_conditions": [],
        "driver_experience": "unknown",
        "missing_fields": ["origin", "destination"],
        "needs_confirmation": True,
    }


def _fallback_route_explanation(payload: dict[str, Any]) -> dict[str, Any]:
    simulated_prefix = "仮データでは、" if payload["is_simulated"] else ""
    explanations = []
    for route in payload["routes"]:
        route_id = route["route_id"]
        minimum_score = route.get("minimum_score")
        hazard_count = route.get("hazard_count")
        facts = []
        if minimum_score is not None:
            facts.append(f"最低走りやすさ指数は{minimum_score}")
        if hazard_count is not None:
            facts.append(f"注意区間は{hazard_count}件")
        summary = simulated_prefix + ("、".join(facts) + "です。" if facts else "入力済みの候補経路です。")
        explanations.append(
            {"route_id": route_id, "summary": summary, "advantages": [], "cautions": []}
        )
    return {
        "recommended_route_id": payload["recommended_route_id"],
        "recommendation_reason": simulated_prefix + "経路探索サービスが確定した順位に基づく推奨です。",
        "routes": explanations,
    }


def _fallback_danger_explanation(payload: dict[str, Any]) -> dict[str, Any]:
    prefix = "仮データ上の注意箇所です。" if payload["is_simulated"] else "登録済みの注意箇所です。"
    return {
        "hazards": [
            {
                "hazard_id": hazard["hazard_id"],
                "explanation": prefix,
                "cautions": [str(rule) for rule in hazard.get("rules", [])],
            }
            for hazard in payload["hazards"]
        ]
    }


def _required_string(value: Any, key: str) -> str:
    if not isinstance(value, dict) or not isinstance(value.get(key), str) or not value[key]:
        raise InputError(f"{key} is required")
    return value[key]


def _evidence_metadata(payload: dict[str, Any]) -> tuple[str, bool]:
    timestamp = payload.get("data_timestamp")
    is_simulated = payload.get("is_simulated")
    if not isinstance(timestamp, str) or not timestamp:
        raise InputError("data_timestamp is required")
    if not isinstance(is_simulated, bool):
        raise InputError("is_simulated must be a boolean")
    return timestamp, is_simulated


def _validate_payload_size(payload: dict[str, Any]) -> None:
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise InputError(f"request body must be {MAX_PAYLOAD_BYTES} bytes or fewer")


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_allowed_list(value: Any, allowed: set[str]) -> bool:
    return _is_string_list(value) and all(item in allowed for item in value)


# Kept as a small compatibility surface for internal callers during migration.
def extract_conditions(text: str) -> dict[str, Any]:
    return _fallback_conditions(text)


def explain_route(route: dict[str, Any]) -> str:
    score = route["minimum_score"]
    hazards = route.get("hazard_count", 0)
    if hazards:
        return f"この経路には走りやすさ指数が{score}の注意区間が{hazards}件あります。"
    return f"この経路の最低走りやすさ指数は{score}で、登録された注意区間はありません。"
