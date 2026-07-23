import json
import unittest

from ai_assistant import handler as handler_module
from ai_assistant.service import AssistantService, InputError, explain_route, extract_conditions


class FakeGenerator:
    model_id = "test.model"

    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


class AssistantTest(unittest.TestCase):
    def test_extracts_structured_conditions_without_coordinates(self):
        output = {
            "origin_query": "長岡駅",
            "destination_query": "石動南町",
            "via_queries": [],
            "priority": "safety",
            "avoid_conditions": ["steep_slope"],
            "prefer_conditions": ["snow_pipe"],
            "driver_experience": "beginner",
            "missing_fields": [],
            "needs_confirmation": True,
        }
        generator = FakeGenerator(output)
        response = AssistantService(generator).parse_route_request(
            {"text": "長岡駅から石動南町まで安全な道で"}
        )
        self.assertEqual(response["result"], output)
        self.assertFalse(response["metadata"]["fallback_used"])
        self.assertNotIn("latitude", generator.calls[0]["schema"]["properties"])

    def test_condition_failure_uses_safe_fallback(self):
        response = AssistantService(FakeGenerator(error=RuntimeError("unavailable"))).parse_route_request(
            {"text": "雪道で安全な経路を教えて"}
        )
        self.assertEqual(response["result"]["priority"], "safety")
        self.assertEqual(response["result"]["missing_fields"], ["origin", "destination"])
        self.assertTrue(response["metadata"]["fallback_used"])

    def test_condition_output_is_checked_against_allow_lists(self):
        invalid = {
            "origin_query": None,
            "destination_query": None,
            "via_queries": [],
            "priority": "invented",
            "avoid_conditions": [],
            "prefer_conditions": [],
            "driver_experience": "unknown",
            "missing_fields": ["origin", "destination"],
            "needs_confirmation": True,
        }
        response = AssistantService(FakeGenerator(invalid)).parse_route_request({"text": "経路を教えて"})
        self.assertEqual(response["result"]["priority"], "balanced")
        self.assertTrue(response["metadata"]["fallback_used"])

    def test_rejects_overlong_text(self):
        with self.assertRaises(InputError):
            AssistantService(FakeGenerator()).parse_route_request({"text": "a" * 1001})

    def test_route_output_cannot_change_identifiers_or_recommendation(self):
        generator = FakeGenerator(
            {
                "recommended_route_id": "route-b",
                "recommendation_reason": "changed",
                "routes": [
                    {"route_id": "route-b", "summary": "x", "advantages": [], "cautions": []}
                ],
            }
        )
        payload = {
            "recommended_route_id": "route-a",
            "data_timestamp": "2026-01-23T12:00:00+09:00",
            "is_simulated": True,
            "routes": [{"route_id": "route-a", "minimum_score": 35, "hazard_count": 2}],
        }
        response = AssistantService(generator).explain_routes(payload)
        self.assertEqual(response["result"]["recommended_route_id"], "route-a")
        self.assertIn("35", response["result"]["routes"][0]["summary"])
        self.assertTrue(response["metadata"]["fallback_used"])

    def test_accepts_route_api_result_and_removes_geometry_before_bedrock(self):
        output = {
            "recommended_route_id": "route-a",
            "recommendation_reason": "確定順位に基づく推奨です。",
            "routes": [
                {
                    "route_id": "route-a",
                    "summary": "走りやすさ指数と除雪状況を確認した経路です。",
                    "advantages": ["消雪パイプのある区間が多いです。"],
                    "cautions": ["凍結要因を含む注意区間があります。"],
                }
            ],
        }
        generator = FakeGenerator(output)
        route_result = {
            "request_id": "route-request-1",
            "mode": "balanced",
            "reference_time": "2026-01-23T12:00:00+09:00",
            "data_timestamp": "2026-01-23T12:00:00+09:00",
            "is_simulated": True,
            "routes": [
                {
                    "route_id": "route-a",
                    "rank": 1,
                    "label": "balanced",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[138.79, 37.44], [138.80, 37.45]],
                    },
                    "segment_ids": ["a", "b"],
                    "distance_m": 2100,
                    "duration_s": 420,
                    "average_drivability_score": 76.5,
                    "minimum_drivability_score": 42,
                    "score_coverage": 1.0,
                    "minimum_confidence": 0.9,
                    "plowed_ratio": 0.6,
                    "snow_pipe_ratio": 0.7,
                    "hazard_group_count": 1,
                    "hazard_groups": [
                        {
                            "segment_ids": ["b"],
                            "factors": ["ice_risk"],
                            "geometry": {
                                "type": "LineString",
                                "coordinates": [[138.79, 37.44], [138.80, 37.45]],
                            },
                        }
                    ],
                    "is_simulated": True,
                }
            ],
            "warnings": [],
        }

        response = AssistantService(generator).explain_routes(route_result)

        self.assertEqual("route-a", response["result"]["recommended_route_id"])
        evidence = generator.calls[0]["payload"]
        self.assertEqual("route-a", evidence["recommended_route_id"])
        self.assertEqual(76.5, evidence["routes"][0]["average_score"])
        self.assertEqual(["ice_risk"], evidence["routes"][0]["hazard_factors"])
        self.assertNotIn("geometry", evidence["routes"][0])
        self.assertNotIn("segment_ids", evidence["routes"][0])

    def test_danger_output_must_preserve_ordered_ids(self):
        output = {
            "hazards": [
                {"hazard_id": "h-1", "explanation": "勾配に注意", "cautions": ["急操作を避ける"]}
            ]
        }
        payload = {
            "data_timestamp": "2026-01-23T12:00:00+09:00",
            "is_simulated": True,
            "hazards": [{"hazard_id": "h-1", "rules": ["steep_slope"]}],
        }
        response = AssistantService(FakeGenerator(output)).explain_danger_points(payload)
        self.assertEqual(response["result"], output)
        self.assertFalse(response["metadata"]["fallback_used"])

    def test_compatibility_helpers_remain_deterministic(self):
        self.assertEqual(extract_conditions("雪道で安全に")["priority"], "safety")
        self.assertIn("2件", explain_route({"minimum_score": 35, "hazard_count": 2}))

    def test_http_handler_returns_api_gateway_response(self):
        output = {
            "origin_query": None,
            "destination_query": None,
            "via_queries": [],
            "priority": "balanced",
            "avoid_conditions": [],
            "prefer_conditions": [],
            "driver_experience": "unknown",
            "missing_fields": ["origin", "destination"],
            "needs_confirmation": True,
        }
        original = handler_module.SERVICE
        handler_module.SERVICE = AssistantService(FakeGenerator(output))
        try:
            response = handler_module.handler(
                {
                    "rawPath": "/v1/ai/parse-route-request",
                    "body": json.dumps({"text": "安全な道"}),
                },
                None,
            )
        finally:
            handler_module.SERVICE = original
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["result"]["priority"], "balanced")


if __name__ == "__main__":
    unittest.main()
