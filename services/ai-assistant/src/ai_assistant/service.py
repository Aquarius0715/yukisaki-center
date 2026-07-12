from __future__ import annotations

from typing import Any


def extract_conditions(text: str) -> dict[str, Any]:
    return {
        "safety_priority": "high" if any(word in text for word in ("安全", "雪道", "危険")) else "normal",
        "requires_explanation": any(word in text for word in ("なぜ", "理由", "危険")),
        "raw_text": text,
    }


def explain_route(route: dict[str, Any]) -> str:
    score = route["minimum_score"]
    hazards = route.get("hazard_count", 0)
    if hazards:
        return f"この経路には走りやすさ指数が{score}の注意区間が{hazards}件あります。"
    return f"この経路の最低走りやすさ指数は{score}で、登録された注意区間はありません。"
