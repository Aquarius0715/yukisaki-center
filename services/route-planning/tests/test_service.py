import json
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

from route_planning.handler import handler
from route_planning.models import RequestValidationError, RouteRequest
from route_planning.service import RoutePlanningService


def request_payload():
    return {
        "origin": {"latitude": 37.4427, "longitude": 138.7908},
        "destination": {"latitude": 37.4510, "longitude": 138.8050},
        "mode": "balanced",
        "options": {"prefer": ["recently_plowed"], "max_detour_minutes": 10},
        "reference_time": "2026-01-23T12:00:00+09:00",
    }


def edge(path_id, path_seq, segment_id, source, target, node, coordinates, *, score=70, cost=20):
    return {
        "path_id": path_id, "path_seq": path_seq, "node": node,
        "edge": path_seq + 1, "cost": cost, "agg_cost": cost * (path_seq + 1),
        "segment_id": segment_id, "source": source, "target": target,
        "st_asgeojson": {"type": "LineString", "coordinates": coordinates},
        "length_m": 100, "base_travel_time_s": 10, "road_type": "primary",
        "max_slope_percent": 2, "bridge": False, "tunnel": False,
        "score": score, "confidence": 0.9, "factors": {},
        "score_is_simulated": True, "snow_pipe": True, "operation_status": "active",
        "observed_at": datetime.fromisoformat("2026-01-23T11:30:00+09:00"),
        "edge_is_simulated": False,
    }


class FakeRepository:
    def plan(self, request, max_snap_distance_m):
        return {
            "graph_version": "graph-v1", "score_rule_version": "score-v1",
            "data_timestamp": "2026-01-23T12:00:00+09:00",
            "origin": {"node_id": 1, "distance_m": 5},
            "destination": {"node_id": 3, "distance_m": 7},
            "rows": [
                edge(1, 0, "ab", 1, 2, 1, [[138.79, 37.44], [138.80, 37.45]]),
                edge(1, 1, "bc", 2, 3, 2, [[138.80, 37.45], [138.81, 37.46]], score=35),
                edge(2, 0, "ad", 1, 4, 1, [[138.79, 37.44], [138.78, 37.45]], cost=24),
                edge(2, 1, "dc", 4, 3, 4, [[138.78, 37.45], [138.81, 37.46]], cost=24),
            ],
        }


class RouteServiceTest(unittest.TestCase):
    def test_validates_public_request_allow_lists(self):
        parsed = RouteRequest.parse(request_payload())
        self.assertEqual("balanced", parsed.mode)
        invalid = request_payload()
        invalid["options"] = {"avoid": ["arbitrary_sql"]}
        with self.assertRaises(RequestValidationError):
            RouteRequest.parse(invalid)

    def test_returns_reproducible_diverse_routes_and_evidence(self):
        service = RoutePlanningService(FakeRepository())
        first = service.plan(request_payload())
        second = service.plan(request_payload())
        self.assertEqual(first, second)
        self.assertEqual(2, len(first["routes"]))
        self.assertEqual("balanced", first["routes"][0]["label"])
        self.assertEqual(["ab", "bc"], first["routes"][0]["segment_ids"])
        self.assertEqual(35, first["routes"][0]["minimum_drivability_score"])
        self.assertEqual(1, first["routes"][0]["hazard_group_count"])
        self.assertEqual(1.0, first["routes"][0]["score_coverage"])
        self.assertTrue(first["is_simulated"])

    def test_handler_returns_http_response(self):
        planned = RoutePlanningService(FakeRepository()).plan(request_payload())
        with patch("route_planning.handler.SERVICE", Mock(plan=Mock(return_value=planned))):
            result = handler({
                "requestContext": {"http": {"method": "POST"}},
                "body": json.dumps(request_payload()),
            }, None)
        self.assertEqual(200, result["statusCode"])
        self.assertEqual("graph-v1", json.loads(result["body"])["graph_version"])

    def test_handler_rejects_invalid_json(self):
        result = handler({
            "requestContext": {"http": {"method": "POST"}},
            "body": "{",
        }, None)
        self.assertEqual(400, result["statusCode"])


if __name__ == "__main__":
    unittest.main()
