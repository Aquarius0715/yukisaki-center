import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

from route_planning.config import DEPARTURE_CANDIDATE_OFFSETS_MINUTES, K_SHORTEST_PATHS
from route_planning.handler import handler
from route_planning.models import Point, RequestValidationError, RouteRequest
from route_planning.repository import PointNotOnRoadError, RoutingRepository
from route_planning.service import RoutePlanningService, _pick_profile_route


def request_payload():
    return {
        "origin": {"latitude": 37.4427, "longitude": 138.7908},
        "destination": {"latitude": 37.4510, "longitude": 138.8050},
        "mode": "balanced",
        "options": {"prefer": ["recently_plowed"], "max_detour_minutes": 10},
        "reference_time": "2026-01-23T12:00:00+09:00",
    }


def edge(
    path_id, path_seq, segment_id, source, target, node, coordinates,
    *, score=70, cost=20, factors=None, road_name=None, max_slope_percent=2,
    bridge=False, observed_at=datetime.fromisoformat("2026-01-23T11:30:00+09:00"),
):
    return {
        "path_id": path_id, "path_seq": path_seq, "node": node,
        "edge": path_seq + 1, "cost": cost, "agg_cost": cost * (path_seq + 1),
        "segment_id": segment_id, "source": source, "target": target,
        "st_asgeojson": {"type": "LineString", "coordinates": coordinates},
        "length_m": 100, "base_travel_time_s": 10, "road_type": "primary",
        "road_name": road_name,
        "max_slope_percent": max_slope_percent, "bridge": bridge, "tunnel": False,
        "score": score, "confidence": 0.9, "factors": factors or {},
        "score_is_simulated": True, "snow_pipe": True, "operation_status": "active",
        "observed_at": observed_at,
        "edge_is_simulated": False,
    }


class NoDeparturePassagesMixin:
    def fetch_training_passage_samples(self, limit_segments):
        return {}

    def fetch_latest_passages(self, segment_ids, before_time):
        return {}


class FakeRepository(NoDeparturePassagesMixin):
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


class HazardFactorRepository(NoDeparturePassagesMixin):
    def plan(self, request, max_snap_distance_m):
        return {
            "graph_version": "graph-v1", "score_rule_version": "score-v1",
            "data_timestamp": "2026-01-23T12:00:00+09:00",
            "origin": {"node_id": 1, "distance_m": 5},
            "destination": {"node_id": 3, "distance_m": 7},
            "rows": [
                edge(
                    1, 0, "hazard-seg", 1, 2, 1,
                    [[138.79, 37.44], [138.80, 37.45]],
                    score=30,
                    road_name="国道351号",
                    observed_at=None,
                    factors={
                        "applied_rules": {"no_plow_history": -15, "narrow_road": -10},
                        "inputs": {"snowfall_1h_cm": 3, "temperature_c": -1.5},
                        "source_run_ids": ["bootstrap-all-roads-x"],
                    },
                ),
            ],
        }


class SimilarRoutesRepository(NoDeparturePassagesMixin):
    def plan(self, request, max_snap_distance_m):
        rows = []
        for path_id, final_segment, cost in (
            (1, "finish-a", 20),
            (2, "finish-b", 21),
            (3, "finish-c", 22),
        ):
            segment_ids = [f"shared-{index}" for index in range(9)] + [final_segment]
            for path_seq, segment_id in enumerate(segment_ids):
                rows.append(
                    edge(
                        path_id,
                        path_seq,
                        segment_id,
                        path_seq + 1,
                        path_seq + 2,
                        path_seq + 1,
                        [[138.79 + path_seq / 1000, 37.44], [138.791 + path_seq / 1000, 37.44]],
                        cost=cost,
                    )
                )
        return {
            "graph_version": "graph-v1",
            "score_rule_version": "score-v1",
            "data_timestamp": "2026-01-23T12:00:00+09:00",
            "origin": {"node_id": 1, "distance_m": 5},
            "destination": {"node_id": 11, "distance_m": 7},
            "rows": rows,
        }


class ComparisonRepository(NoDeparturePassagesMixin):
    def __init__(self):
        self.modes = []

    def plan(self, request, max_snap_distance_m):
        self.modes.append(request.mode)
        profile = {
            "balanced": ("balanced-path", 75, 20),
            "drivability_priority": ("drivable-path", 92, 24),
            "distance_priority": ("distance-path", 68, 18),
        }[request.mode]
        segment_id, score, cost = profile
        return {
            "graph_version": "graph-v1",
            "score_rule_version": "score-v1",
            "data_timestamp": "2026-01-23T12:00:00+09:00",
            "origin": {"node_id": 1, "distance_m": 5},
            "destination": {"node_id": 2, "distance_m": 7},
            "rows": [
                edge(
                    1,
                    0,
                    segment_id,
                    1,
                    2,
                    1,
                    [[138.79, 37.44], [138.81, 37.46]],
                    score=score,
                    cost=cost,
                ),
            ],
        }


class DeparturePredictionRepository(HazardFactorRepository):
    """Same single-segment route as HazardFactorRepository, but with enough
    pooled passage history elsewhere on the network for the departure model
    to train instead of falling back to insufficient_data."""

    def fetch_training_passage_samples(self, limit_segments):
        # Gaps must comfortably exceed the no-history sentinel
        # (DEPARTURE_NO_HISTORY_ELAPSED_MINUTES = 240) so the model's
        # training range covers "hazard-seg" below and the extrapolation
        # guard in recommend_departure doesn't reject it.
        base = datetime.fromisoformat("2026-01-20T00:00:00+09:00")
        return {
            f"train-{i}": [base + timedelta(hours=i), base + timedelta(hours=i, minutes=260)]
            for i in range(30)
        }

    def fetch_latest_passages(self, segment_ids, before_time):
        return {}


class PlaceholderCheckingCursor:
    def __init__(self):
        self.executed = []
        self.description = []

    def execute(self, sql, parameters=None):
        if parameters is not None:
            assert sql.count("%s") == len(parameters), (sql.count("%s"), len(parameters))
        self.executed.append((sql, parameters))

    def fetchone(self):
        return None

    def fetchall(self):
        return []


class _FakeCursorContext:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self._cursor

    def __exit__(self, *args):
        return False


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return _FakeCursorContext(self._cursor)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class RouteServiceTest(unittest.TestCase):
    def test_validates_public_request_allow_lists(self):
        parsed = RouteRequest.parse(request_payload())
        self.assertEqual("balanced", parsed.mode)
        comparison = request_payload()
        comparison["mode"] = "comparison"
        self.assertEqual("comparison", RouteRequest.parse(comparison).mode)
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
        self.assertNotIn("_path", first["routes"][0])
        # Every edge in this fixture was plowed 30 minutes before reference_time,
        # so the top route is already fresh and needs no departure delay.
        self.assertEqual(0, first["departure_recommendation"]["recommended_offset_minutes"])
        self.assertFalse(first["departure_recommendation"]["insufficient_data"])
        self.assertEqual([], first["departure_recommendation"]["evaluated_segment_ids"])

    def test_departure_recommendation_reports_insufficient_data_without_passage_history(self):
        result = RoutePlanningService(HazardFactorRepository()).plan(request_payload())

        recommendation = result["departure_recommendation"]
        self.assertTrue(recommendation["insufficient_data"])
        self.assertEqual(["hazard-seg"], recommendation["evaluated_segment_ids"])
        self.assertEqual([], recommendation["candidates"])
        self.assertTrue(recommendation["is_prediction"])
        self.assertTrue(recommendation["is_simulated"])

    def test_departure_recommendation_predicts_offsets_when_network_history_exists(self):
        result = RoutePlanningService(DeparturePredictionRepository()).plan(request_payload())

        recommendation = result["departure_recommendation"]
        self.assertFalse(recommendation["insufficient_data"])
        self.assertEqual(["hazard-seg"], recommendation["evaluated_segment_ids"])
        self.assertEqual(len(DEPARTURE_CANDIDATE_OFFSETS_MINUTES), len(recommendation["candidates"]))
        self.assertIn(recommendation["recommended_offset_minutes"], DEPARTURE_CANDIDATE_OFFSETS_MINUTES)
        reference_time = datetime.fromisoformat(request_payload()["reference_time"])
        expected_departure = reference_time + timedelta(minutes=recommendation["recommended_offset_minutes"])
        self.assertEqual(expected_departure.isoformat(), recommendation["recommended_departure_time"])
        for candidate in recommendation["candidates"]:
            self.assertGreaterEqual(candidate["minimum_plow_probability"], 0.0)
            self.assertLessEqual(candidate["minimum_plow_probability"], 1.0)
            self.assertGreaterEqual(candidate["average_plow_probability"], 0.0)
            self.assertLessEqual(candidate["average_plow_probability"], 1.0)

    def test_hazard_factors_unwrap_applied_rules_not_the_score_envelope(self):
        service = RoutePlanningService(HazardFactorRepository())
        result = service.plan(request_payload())
        hazards = result["routes"][0]["hazard_groups"]
        self.assertEqual(1, len(hazards))
        self.assertEqual(["narrow_road", "no_plow_history"], hazards[0]["factors"])

    def test_hazard_evidence_carries_concrete_values_for_ai_grounding(self):
        service = RoutePlanningService(HazardFactorRepository())
        result = service.plan(request_payload())
        evidence = result["routes"][0]["hazard_groups"][0]["evidence"]
        self.assertEqual("国道351号", evidence["road_name"])
        self.assertEqual(3, evidence["snowfall_1h_cm"])
        self.assertEqual(-1.5, evidence["temperature_c"])
        self.assertEqual(100, evidence["length_m"])
        # No observed_at on the only edge in this hazard means the group has no
        # plow history at all, so last_plowed_at must not be fabricated.
        self.assertNotIn("last_plowed_at", evidence)

    def test_cost_cache_key_tracks_cost_inputs_but_not_candidate_filter(self):
        request = RouteRequest.parse(request_payload())
        key = RoutingRepository._cost_cache_key(
            request,
            "graph-v1",
            "score-v1",
            "2026-01-23T12:00:00+09:00",
        )
        same_costs = request_payload()
        same_costs["options"]["max_detour_minutes"] = 30
        same_key = RoutingRepository._cost_cache_key(
            RouteRequest.parse(same_costs),
            "graph-v1",
            "score-v1",
            "2026-01-23T12:00:00+09:00",
        )
        different_mode = request_payload()
        different_mode["mode"] = "time_priority"
        different_key = RoutingRepository._cost_cache_key(
            RouteRequest.parse(different_mode),
            "graph-v1",
            "score-v1",
            "2026-01-23T12:00:00+09:00",
        )

        self.assertEqual(key, same_key)
        self.assertNotEqual(key, different_key)

    def test_snap_validates_distance_to_edge_not_only_distance_to_endpoint_node(self):
        cursor = Mock()
        cursor.fetchone.return_value = (
            123,
            "node-123",
            37.442,
            138.791,
            180.0,
            12.5,
        )

        snapped = RoutingRepository._snap(
            cursor,
            Point(latitude=37.4427, longitude=138.7908),
            "graph-v1",
            100.0,
        )

        self.assertEqual(180.0, snapped["distance_m"])
        self.assertEqual(12.5, snapped["road_distance_m"])
        self.assertIn("nearest_edge", cursor.execute.call_args.args[0])

    def test_snap_rejects_point_when_nearest_edge_is_too_far(self):
        cursor = Mock()
        cursor.fetchone.return_value = (
            123,
            "node-123",
            37.442,
            138.791,
            20.0,
            100.1,
        )

        with self.assertRaises(PointNotOnRoadError):
            RoutingRepository._snap(
                cursor,
                Point(latitude=37.4427, longitude=138.7908),
                "graph-v1",
                100.0,
            )

    def test_cost_cache_sql_parameters_match_with_and_without_plow_preference(self):
        for prefer in ([], ["recently_plowed"]):
            payload = request_payload()
            payload["options"]["prefer"] = prefer
            cursor = PlaceholderCheckingCursor()

            RoutingRepository._prepare_cost_edges(
                cursor,
                RouteRequest.parse(payload),
                "graph-v1",
                "score-v1",
                "2026-01-23T12:00:00+09:00",
            )

            cost_sql = next(sql for sql, _ in cursor.executed if "latest_scores" in sql)
            self.assertIn("LEFT JOIN latest_scores", cost_sql)
            if prefer:
                self.assertIn("FROM snowplow_segment_passages", cost_sql)
            else:
                self.assertNotIn("FROM snowplow_segment_passages", cost_sql)

    def test_path_sql_projects_cached_costs_for_static_pgrouting_query(self):
        cursor = PlaceholderCheckingCursor()

        RoutingRepository._path_rows(
            cursor,
            1,
            2,
            RouteRequest.parse(request_payload()),
            "score-v1",
            "route-cost-key",
            "graph-v1",
        )

        projection_sql, projection_parameters = cursor.executed[1]
        path_sql, path_parameters = cursor.executed[2]
        self.assertIn("CREATE TEMP TABLE route_cost_edges", projection_sql)
        self.assertEqual("route-cost-key", projection_parameters[0])
        self.assertEqual("graph-v1", projection_parameters[1])
        self.assertIn("ST_MakeEnvelope", projection_sql)
        self.assertIn("FROM route_cost_edges", path_sql)
        self.assertNotIn("format(", path_sql)
        self.assertEqual(K_SHORTEST_PATHS, path_parameters[2])
        self.assertEqual(
            2,
            sum("CREATE TEMP TABLE route_cost_edges" in sql for sql, _ in cursor.executed),
        )

    def test_returns_three_distinct_routes_when_ksp_paths_differ_locally(self):
        result = RoutePlanningService(SimilarRoutesRepository()).plan(request_payload())

        self.assertEqual(3, len(result["routes"]))
        self.assertEqual([1, 2, 3], [route["rank"] for route in result["routes"]])
        self.assertEqual(
            {"finish-a", "finish-b", "finish-c"},
            {route["segment_ids"][-1] for route in result["routes"]},
        )

    def test_comparison_returns_three_profiled_routes_and_fixed_recommendation(self):
        repository = ComparisonRepository()
        payload = request_payload()
        payload["mode"] = "comparison"

        result = RoutePlanningService(repository).plan(payload)

        self.assertCountEqual(
            ["balanced", "drivability_priority", "distance_priority"],
            repository.modes,
        )
        self.assertEqual(
            ["balanced", "most_drivable", "distance_priority"],
            [route["label"] for route in result["routes"]],
        )
        self.assertEqual(
            ["balanced-path", "drivable-path", "distance-path"],
            [route["segment_ids"][0] for route in result["routes"]],
        )
        self.assertEqual(result["routes"][0]["route_id"], result["recommended_route_id"])
        self.assertEqual("comparison", result["mode"])

    def test_profile_selection_skips_visually_similar_paths(self):
        selected = {"segment_ids": [f"shared-{index}" for index in range(20)]}
        similar = {
            "segment_ids": [f"shared-{index}" for index in range(18)]
            + ["similar-a", "similar-b"],
        }
        distinct = {
            "segment_ids": ["shared-0", "shared-19"]
            + [f"distinct-{index}" for index in range(18)],
        }

        result = _pick_profile_route([similar, distinct], [selected])

        self.assertIs(result, distinct)
        self.assertIsNone(_pick_profile_route([similar], [selected]))

    def test_distance_priority_cost_uses_length_basis(self):
        payload = request_payload()
        payload["mode"] = "distance_priority"
        cursor = PlaceholderCheckingCursor()

        RoutingRepository._prepare_cost_edges(
            cursor,
            RouteRequest.parse(payload),
            "graph-v1",
            "score-v1",
            "2026-01-23T12:00:00+09:00",
        )

        cost_sql = next(sql for sql, _ in cursor.executed if "latest_scores" in sql)
        self.assertIn("e.length_m::float8 / 13.8888888889", cost_sql)

    def test_training_passage_query_samples_segments_randomly(self):
        # An alphabetical ORDER BY would let whichever segment_ids happen to
        # sort first dominate the pooled training set every time (and any
        # mock data seeded for testing could simply never be selected).
        cursor = PlaceholderCheckingCursor()
        repository = RoutingRepository(connection_factory=lambda: _FakeConnection(cursor))

        repository.fetch_training_passage_samples(300)

        candidate_sql, parameters = cursor.executed[0]
        self.assertIn("ORDER BY random()", candidate_sql)
        self.assertNotIn("ORDER BY segment_id", candidate_sql)
        self.assertEqual((300,), parameters)

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
