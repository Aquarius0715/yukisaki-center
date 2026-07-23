from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from decimal import Decimal

from yukisaki_api.handler import handle
from yukisaki_api.service import MapQuery, MapService, RequestError


class FakeRepository:
    @staticmethod
    def _road():
        return {
            "segment_id": "road-1",
            "geometry_geojson": {"type": "LineString", "coordinates": [[138.78, 37.44], [138.79, 37.45]]},
            "road_name": "長岡道路", "road_type": "primary", "length_m": Decimal("120.5"),
            "max_slope_percent": Decimal("2.4"), "source": "openstreetmap", "source_version": "1",
            "snapshot_date": datetime(2026, 1, 23, tzinfo=timezone.utc).date(), "road_is_simulated": False,
            "snow_pipe": True, "operation_status": "active", "effectiveness": Decimal("0.8"),
            "snow_pipe_updated_at": datetime(2026, 1, 23, 3, tzinfo=timezone.utc),
            "snow_pipe_source": "demo", "snow_pipe_is_simulated": True,
            "data_timestamp": datetime(2026, 1, 23, 3, 1, tzinfo=timezone.utc), "score": 82,
            "confidence": Decimal("0.9"), "factors": {"plowed": True}, "rule_version": "v1",
            "score_is_simulated": True, "observed_at": datetime(2026, 1, 23, 3, tzinfo=timezone.utc),
            "vehicle_id": "plow-01",
        }

    def road_segments(self, bbox, limit, cursor=None):
        west, south, east, north = bbox
        if not (west <= 138.79 and east >= 138.78 and south <= 37.45 and north >= 37.44):
            return []
        return [self._road()][: limit + 1]

    def road_segment(self, segment_id):
        return self._road() if segment_id == "road-1" else None

    def snowplows(self):
        return [{
            "vehicle_id": "plow-01", "display_name": "除雪車1", "observed_at": datetime(2026, 1, 23, 3, tzinfo=timezone.utc),
            "received_at": datetime(2026, 7, 22, 2, tzinfo=timezone.utc),
            "latitude": 37.44, "longitude": 138.78, "speed_kmh": Decimal("18.0"),
            "heading_degrees": Decimal("90"), "accuracy_m": Decimal("3"), "operation": "plowing",
            "matched_segment_id": "road-1", "match_distance_m": Decimal("1.2"), "run_id": "run-1", "is_simulated": True,
        }]


def event(path, params=None, method="GET"):
    return {"rawPath": path, "queryStringParameters": params, "requestContext": {"http": {"method": method, "path": path}}}


class MapApiTest(unittest.TestCase):
    def setUp(self):
        self.service = MapService(FakeRepository())

    def test_road_segments_are_geojson_and_include_required_metadata(self):
        response = handle(event("/v1/road-segments"), self.service)
        body = json.loads(response["body"])
        self.assertEqual(200, response["statusCode"])
        self.assertEqual("FeatureCollection", body["type"])
        self.assertEqual(82, body["features"][0]["properties"]["drivability_score"])
        self.assertTrue(body["features"][0]["properties"]["is_simulated"])
        self.assertIn("access-control-allow-origin", response["headers"])

    def test_snowplows_return_point_geojson(self):
        body = json.loads(handle(event("/v1/snowplows"), self.service)["body"])
        self.assertEqual([138.78, 37.44], body["features"][0]["geometry"]["coordinates"])
        self.assertEqual("road-1", body["features"][0]["properties"]["matched_segment_id"])
        self.assertEqual("2026-07-22T02:00:00+00:00", body["features"][0]["properties"]["data_timestamp"])

    def test_snapshot_connects_roads_and_snowplows(self):
        body = json.loads(handle(event("/v1/map/snapshot", {"bbox": "138.7,37.4,138.9,37.5"}), self.service)["body"])
        self.assertEqual("road-1", body["roads"]["features"][0]["id"])
        self.assertEqual("plow-01", body["snowplows"]["features"][0]["id"])
        self.assertEqual("2026-01-23", body["demo"]["target_date"])

    def test_bbox_excludes_outside_roads(self):
        result = self.service.roads(MapQuery.parse({"bbox": "139,38,140,39"}))
        self.assertEqual([], result["features"])

    def test_invalid_bbox_is_400(self):
        response = handle(event("/v1/road-segments", {"bbox": "invalid"}), self.service)
        self.assertEqual(400, response["statusCode"])

    def test_query_rejects_excessive_limit(self):
        with self.assertRaises(RequestError):
            MapQuery.parse({"limit": "5001"})

    def test_road_pages_return_a_cursor_when_more_rows_exist(self):
        class PagedRepository(FakeRepository):
            def road_segments(self, bbox, limit, cursor=None):
                rows = [
                    {**self._road(), "segment_id": "road-1"},
                    {**self._road(), "segment_id": "road-2"},
                ]
                return [row for row in rows if row["segment_id"] > (cursor or "")][: limit + 1]

        service = MapService(PagedRepository())
        first = service.roads(MapQuery.parse({"limit": "1"}))
        second = service.roads(MapQuery.parse({"limit": "1", "cursor": first["next_cursor"]}))
        self.assertTrue(first["truncated"])
        self.assertEqual("road-1", first["next_cursor"])
        self.assertEqual("road-2", second["features"][0]["properties"]["segment_id"])
        self.assertIsNone(second["next_cursor"])

    def test_unknown_segment_is_404(self):
        self.assertEqual(404, handle(event("/v1/road-segments/missing"), self.service)["statusCode"])


if __name__ == "__main__":
    unittest.main()
