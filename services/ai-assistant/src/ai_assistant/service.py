from __future__ import annotations

import json
import logging
import math
from typing import Any, Protocol

from .prompts import (
    CONDITION_SYSTEM_PROMPT,
    DANGER_EXPLANATION_SYSTEM_PROMPT,
    ROUTE_EXPLANATION_SYSTEM_PROMPT,
)
from .schemas import CONDITION_SCHEMA, ROUTE_EXPLANATION_SCHEMA, danger_explanation_schema


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
        payload = _normalize_route_result(payload)
        _validate_payload_size(payload)
        routes = payload["routes"]
        recommended_route_id = payload["recommended_route_id"]
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
            ) and _route_explanation_is_grounded(result, payload)

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
            # Bedrock's structured-output schema can restrict hazard_id to the
            # known set (enum) but cannot require an exact array length
            # (minItems/maxItems above 1 are rejected). The model sometimes
            # repeats the whole set instead of returning it once, so accept
            # that by de-duplicating rather than forcing a fallback for
            # otherwise-valid content.
            if set(result) != {"hazards"}:
                return False
            output_hazards = result.get("hazards")
            if not isinstance(output_hazards, list):
                return False
            by_id: dict[str, dict[str, Any]] = {}
            for item in output_hazards:
                if (
                    isinstance(item, dict)
                    and set(item) == {"hazard_id", "explanation", "cautions"}
                    and isinstance(item.get("hazard_id"), str)
                    and isinstance(item.get("explanation"), str)
                    and _is_string_list(item.get("cautions"))
                ):
                    by_id.setdefault(item["hazard_id"], item)
            if set(by_id) != set(hazard_ids):
                return False
            result["hazards"] = [by_id[hazard_id] for hazard_id in hazard_ids]
            return True

        result, fallback_used = self._generate_or_fallback(
            schema_name="danger_explanations",
            schema=danger_explanation_schema(hazard_ids),
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


def _route_explanation_is_grounded(
    result: dict[str, Any],
    payload: dict[str, Any],
) -> bool:
    text = json.dumps(result, ensure_ascii=False)
    unsupported_claims = (
        "渋滞",
        "事故",
        "規制",
        "通行止め",
        "横風",
        "積雪",
        "路面",
        "除雪実施率",
        "融雪設備",
        "走行環境の質",
        "安定した走行環境",
        "安全な経路",
        "安全性",
        "安心",
        "残る可能性",
        "管理が充実",
        "課題",
    )
    if any(claim in text for claim in unsupported_claims):
        return False

    factors = {
        factor
        for route in payload["routes"]
        for factor in route.get("hazard_factors", [])
    }
    if "凍結" in text and not factors & {"freezing_wet_condition", "ice_risk"}:
        return False
    if "降雪" in text and not factors & {
        "heavy_hourly_snowfall",
        "moderate_hourly_snowfall",
        "light_hourly_snowfall",
        "freezing_wet_condition",
    }:
        return False
    return True


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
    routes = payload["routes"]
    recommended = next(
        route
        for route in routes
        if route["route_id"] == payload["recommended_route_id"]
    )
    explanations = [
        {
            "route_id": route["route_id"],
            "summary": _route_summary(route),
            "advantages": _route_advantages(route, routes),
            "cautions": _route_cautions(route),
        }
        for route in routes
    ]
    return {
        "recommended_route_id": payload["recommended_route_id"],
        "recommendation_reason": _recommendation_reason(recommended, routes),
        "routes": explanations,
    }


def _route_summary(route: dict[str, Any]) -> str:
    label = {
        "fastest": "所要時間を重視した",
        "balanced": "所要時間と走りやすさのバランスを重視した",
        "most_drivable": "走りやすさを重視した",
        "distance_priority": "距離を重視した",
        "alternative": "比較用の",
    }.get(route.get("label"), "比較用の")
    facts = []
    if route.get("distance_m") is not None:
        facts.append(f"距離は{_format_distance(route['distance_m'])}")
    if route.get("duration_s") is not None:
        facts.append(f"所要時間は{_format_duration(route['duration_s'])}")
    score_facts = []
    if route.get("average_score") is not None:
        score_facts.append(f"平均走りやすさ指数は{_format_number(route['average_score'])}")
    if route.get("minimum_score") is not None:
        score_facts.append(f"最低走りやすさ指数は{_format_number(route['minimum_score'])}")
    hazard_count = route.get("hazard_count")
    hazard_text = (
        f"ルールで集約された注意区間は{hazard_count}件です。"
        if hazard_count is not None
        else "注意区間数の情報はありません。"
    )
    first = f"第{route['rank']}候補で、{label}経路です。"
    second = "、".join(facts) + "です。" if facts else "距離と所要時間の情報はありません。"
    third = "、".join(score_facts) + f"で、{hazard_text}" if score_facts else hazard_text
    return first + second + third


def _route_advantages(
    route: dict[str, Any],
    routes: list[dict[str, Any]],
) -> list[str]:
    advantages = []
    durations = [item["duration_s"] for item in routes if item.get("duration_s") is not None]
    minimum_scores = [
        item["minimum_score"] for item in routes if item.get("minimum_score") is not None
    ]
    average_scores = [
        item["average_score"] for item in routes if item.get("average_score") is not None
    ]
    if route.get("duration_s") is not None and route["duration_s"] == min(durations):
        advantages.append(
            f"候補の中で所要時間が最短の{_format_duration(route['duration_s'])}です。"
        )
    if (
        route.get("minimum_score") is not None
        and route["minimum_score"] == max(minimum_scores)
    ):
        advantages.append(
            f"候補の中で最低走りやすさ指数が最も高い{_format_number(route['minimum_score'])}です。"
        )
    if (
        route.get("average_score") is not None
        and route["average_score"] == max(average_scores)
    ):
        advantages.append(
            f"候補の中で平均走りやすさ指数が最も高い{_format_number(route['average_score'])}です。"
        )
    if route.get("score_coverage") == 1:
        advantages.append("走りやすさ指数は経路全体をカバーしています。")
    if route.get("plowed_ratio") is not None and route["plowed_ratio"] > 0:
        advantages.append(
            "基準時刻前60分以内の除雪履歴を確認できる区間は"
            f"{_format_percent(route['plowed_ratio'])}です。"
        )
    if route.get("snow_pipe_ratio") is not None and route["snow_pipe_ratio"] > 0:
        advantages.append(
            f"稼働中の消雪パイプがある区間は{_format_percent(route['snow_pipe_ratio'])}です。"
        )
    if not advantages:
        advantages.append("入力された条件と走りやすさコストに基づいて順位付けされた候補です。")
    return advantages[:4]


def _route_cautions(route: dict[str, Any]) -> list[str]:
    cautions = []
    hazard_count = route.get("hazard_count")
    factors = route.get("hazard_factors", [])
    if hazard_count:
        factor_text = "、".join(_factor_label(factor) for factor in factors)
        suffix = f"主な要因は{factor_text}です。" if factor_text else "要因の詳細を確認してください。"
        cautions.append(f"注意区間が{hazard_count}件あります。{suffix}")
    elif hazard_count == 0:
        cautions.append("ルールで集約された注意区間はありません。")
    coverage = route.get("score_coverage")
    if coverage is not None and coverage < 1:
        cautions.append(
            "走りやすさ指数のカバレッジは"
            f"{_format_percent(coverage)}で、未算出区間を含みます。"
        )
    confidence = route.get("minimum_confidence")
    if confidence is not None and confidence < 1:
        cautions.append(
            f"区間ごとの指数の最低信頼度は{_format_number(confidence)}です。"
        )
    plowed_ratio = route.get("plowed_ratio")
    if plowed_ratio is not None and plowed_ratio < 1:
        cautions.append(
            "基準時刻前60分以内の除雪履歴を確認できる区間は"
            f"{_format_percent(plowed_ratio)}です。"
        )
    snow_pipe_ratio = route.get("snow_pipe_ratio")
    if snow_pipe_ratio is not None and snow_pipe_ratio < 1:
        cautions.append(
            f"稼働中の消雪パイプがある区間は{_format_percent(snow_pipe_ratio)}です。"
        )
    return cautions[:4]


def _recommendation_reason(
    recommended: dict[str, Any],
    routes: list[dict[str, Any]],
) -> str:
    reason = "経路探索の総合バランス評価で確定した経路として、この経路を推奨します。"
    facts = []
    if recommended.get("duration_s") is not None:
        facts.append(f"所要時間は{_format_duration(recommended['duration_s'])}")
    if recommended.get("minimum_score") is not None:
        facts.append(
            f"最低走りやすさ指数は{_format_number(recommended['minimum_score'])}"
        )
    if recommended.get("hazard_count") is not None:
        facts.append(f"注意区間は{recommended['hazard_count']}件")
    if facts:
        reason += "この経路の" + "、".join(facts) + "です。"

    alternative = next(
        (route for route in routes if route["route_id"] != recommended["route_id"]),
        None,
    )
    if alternative is not None:
        differences = _route_differences(recommended, alternative)
        if differences:
            reason += f"第{alternative['rank']}候補と比べると、" + "、".join(differences) + "。"
    return reason


def _route_differences(
    first: dict[str, Any],
    second: dict[str, Any],
) -> list[str]:
    differences = []
    if first.get("duration_s") is not None and second.get("duration_s") is not None:
        delta = first["duration_s"] - second["duration_s"]
        if delta:
            differences.append(
                f"所要時間が{_format_duration(abs(delta))}{'長い' if delta > 0 else '短い'}"
            )
    if first.get("minimum_score") is not None and second.get("minimum_score") is not None:
        delta = first["minimum_score"] - second["minimum_score"]
        if delta:
            differences.append(
                "最低走りやすさ指数が"
                f"{_format_number(abs(delta))}{'高い' if delta > 0 else '低い'}"
            )
    if first.get("hazard_count") is not None and second.get("hazard_count") is not None:
        delta = first["hazard_count"] - second["hazard_count"]
        if delta:
            differences.append(f"注意区間が{abs(delta)}件{'多い' if delta > 0 else '少ない'}")
    return differences


def _format_number(value: int | float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:.1f}"


def _format_distance(value: int | float) -> str:
    if value >= 1_000:
        return f"{value / 1_000:.1f}km"
    return f"{_format_number(value)}m"


def _format_duration(value: int | float) -> str:
    seconds = round(value)
    minutes, remaining = divmod(seconds, 60)
    if minutes and remaining:
        return f"{minutes}分{remaining}秒"
    if minutes:
        return f"{minutes}分"
    return f"{remaining}秒"


def _format_percent(value: int | float) -> str:
    return f"{round(value * 100)}%"


FACTOR_LABELS = {
    "heavy_hourly_snowfall": "1時間降雪量が多いこと",
    "moderate_hourly_snowfall": "1時間降雪量がやや多いこと",
    "light_hourly_snowfall": "降雪があること",
    "steep_slope": "急勾配",
    "moderate_slope": "勾配",
    "plowed_within_60_minutes": "直近60分以内の除雪履歴",
    "plowed_60_to_180_minutes_ago": "最終除雪から60〜180分経過していること",
    "plowed_over_180_minutes_ago": "最終除雪から180分以上経過していること",
    "no_plow_history": "除雪履歴がないこと",
    "active_snow_pipe": "稼働中の消雪パイプ",
    "freezing_wet_condition": "氷点付近の降雪条件",
    "bridge": "橋梁区間",
    "ice_risk": "凍結に関する判定要因",
    "narrow_road": "幅員が狭い生活道路区間",
}

EVIDENCE_FORMATTERS = {
    "temperature_c": lambda value: f"気温は{value}℃",
    "snowfall_1h_cm": lambda value: f"1時間降雪量は{value}cm",
    "snow_depth_m": lambda value: f"積雪深は{value}m",
    "max_slope_percent": lambda value: f"最大勾配は{value}%",
    "last_plowed_at": lambda value: f"最終除雪時刻は{value}",
    "score": lambda value: f"走りやすさ指数は{value}",
    "confidence": lambda value: f"信頼度は{value}",
    "road_name": lambda value: f"道路名は{value}",
    "length_m": lambda value: f"区間長は{value}m",
}


def _factor_label(factor: str) -> str:
    return FACTOR_LABELS.get(factor, f"判定要因「{factor}」")


def _normalize_route_result(payload: dict[str, Any]) -> dict[str, Any]:
    """Reduce a route API result to bounded, evidence-only LLM input.

    Geometry and segment identifiers are intentionally omitted. The route
    service remains the owner of ranking and numerical evaluation.
    """
    if not isinstance(payload, dict):
        raise InputError("request body must be an object")
    routes = payload.get("routes")
    if not isinstance(routes, list) or not 1 <= len(routes) <= 3:
        raise InputError("routes must contain between 1 and 3 routes")

    normalized_routes = []
    route_ids = []
    for index, route in enumerate(routes, start=1):
        route_id = _required_string(route, "route_id")
        route_ids.append(route_id)
        hazard_groups = route.get("hazard_groups", [])
        factors: set[str] = set()
        if isinstance(hazard_groups, list):
            for hazard in hazard_groups:
                if not isinstance(hazard, dict):
                    continue
                values = hazard.get("factors")
                if isinstance(values, list):
                    factors.update(
                        value
                        for value in values
                        if isinstance(value, str) and 0 < len(value) <= 64
                    )
        normalized_routes.append(
            {
                "route_id": route_id,
                "rank": route.get("rank")
                if isinstance(route.get("rank"), int)
                else index,
                "label": route.get("label")
                if route.get("label")
                in {"fastest", "balanced", "most_drivable", "distance_priority", "alternative"}
                else "alternative",
                "distance_m": _number(route.get("distance_m")),
                "duration_s": _number(route.get("duration_s")),
                "average_score": _number(
                    route.get("average_drivability_score", route.get("average_score"))
                ),
                "minimum_score": _number(
                    route.get("minimum_drivability_score", route.get("minimum_score"))
                ),
                "score_coverage": _number(route.get("score_coverage")),
                "minimum_confidence": _number(route.get("minimum_confidence")),
                "plowed_ratio": _number(route.get("plowed_ratio")),
                "snow_pipe_ratio": _number(route.get("snow_pipe_ratio")),
                "hazard_count": int(
                    route.get("hazard_group_count", route.get("hazard_count", 0))
                )
                if isinstance(
                    route.get("hazard_group_count", route.get("hazard_count", 0)),
                    int,
                )
                else None,
                "hazard_factors": sorted(factors)[:20],
            }
        )

    if len(route_ids) != len(set(route_ids)):
        raise InputError("route_id must be unique")
    recommended_route_id = payload.get("recommended_route_id")
    if recommended_route_id is None:
        recommended_route_id = min(
            normalized_routes, key=lambda route: (route["rank"], route["route_id"])
        )["route_id"]
    if recommended_route_id not in route_ids:
        raise InputError("recommended_route_id must identify an input route")

    warnings = payload.get("warnings", [])
    safe_warnings = (
        [item[:200] for item in warnings[:10] if isinstance(item, str)]
        if isinstance(warnings, list)
        else []
    )
    data_timestamp, is_simulated = _evidence_metadata(payload)
    return {
        "route_request_id": payload.get("request_id")
        if isinstance(payload.get("request_id"), str)
        else None,
        "recommended_route_id": recommended_route_id,
        "mode": payload.get("mode")
        if payload.get("mode")
        in {
            "time_priority",
            "balanced",
            "drivability_priority",
            "distance_priority",
            "comparison",
        }
        else None,
        "reference_time": payload.get("reference_time")
        if isinstance(payload.get("reference_time"), str)
        else None,
        "data_timestamp": data_timestamp,
        "is_simulated": is_simulated,
        "routes": normalized_routes,
        "warnings": safe_warnings,
    }


def _number(value: Any) -> int | float | None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        return None
    return value


def _fallback_danger_explanation(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "hazards": [
            {
                "hazard_id": hazard["hazard_id"],
                "explanation": _danger_summary(hazard),
                "cautions": _danger_cautions(hazard),
            }
            for hazard in payload["hazards"]
        ]
    }


def _danger_summary(hazard: dict[str, Any]) -> str:
    rules = [
        _factor_label(str(rule))
        for rule in hazard.get("rules", [])
        if isinstance(rule, str)
    ]
    if rules:
        explanation = "この注意箇所では、" + "、".join(rules) + "が判定根拠です。"
    else:
        explanation = "この注意箇所には、入力済みの判定根拠があります。"
    evidence = hazard.get("evidence")
    if isinstance(evidence, dict):
        details = [
            _evidence_text(key, value)
            for key, value in evidence.items()
            if isinstance(key, str)
            and isinstance(value, (str, int, float))
            and not isinstance(value, bool)
        ][:4]
        if details:
            explanation += "確認された値は、" + "、".join(details) + "です。"
    explanation += "経路通過時は、この根拠に対応した運転上の注意が必要です。"
    return explanation


def _evidence_text(key: str, value: str | int | float) -> str:
    formatter = EVIDENCE_FORMATTERS.get(key)
    if formatter is not None:
        return formatter(value)
    return f"根拠項目「{key}」は{value}"


def _danger_cautions(hazard: dict[str, Any]) -> list[str]:
    rules = {
        str(rule)
        for rule in hazard.get("rules", [])
        if isinstance(rule, str)
    }
    cautions = []
    if rules & {"steep_slope", "moderate_slope"}:
        cautions.append("勾配区間では速度を抑え、急な加減速や急ハンドルを避けてください。")
    if "bridge" in rules:
        cautions.append("橋梁区間では路面状況の変化を見込み、手前から速度を落としてください。")
    if rules & {
        "heavy_hourly_snowfall",
        "moderate_hourly_snowfall",
        "light_hourly_snowfall",
        "freezing_wet_condition",
        "ice_risk",
    }:
        cautions.append("十分な車間距離を取り、急ブレーキを避けて走行してください。")
    if rules & {
        "plowed_60_to_180_minutes_ago",
        "plowed_over_180_minutes_ago",
        "no_plow_history",
    }:
        cautions.append("除雪履歴の状況を踏まえ、路面の変化に対応できる速度で走行してください。")
    if "narrow_road" in rules:
        cautions.append("幅員が狭い区間があるため、対向車とのすれ違いに注意して走行してください。")
    if not cautions:
        cautions.append("入力された注意情報を確認し、速度を抑えて慎重に走行してください。")
    return cautions[:3]


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
