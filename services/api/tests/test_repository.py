from __future__ import annotations

import unittest
from decimal import Decimal
from unittest.mock import patch

from yukisaki_api.repository import (
    ROAD_MAP_SEGMENTS_SQL,
    ROAD_SEGMENTS_SQL,
    PostgresMapRepository,
)


class FakeSnowplowLiveTable:
    def __init__(self, items):
        self._items = items

    def scan(self):
        return {"Items": self._items}


class FakeCursor:
    description = []

    def __init__(self):
        self.parameters = None
        self.sql = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, parameters):
        self.sql = sql
        self.parameters = parameters

    def fetchall(self):
        return []


class FakeConnection:
    def __init__(self, cursor):
        self.database_cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.database_cursor


class RepositoryTest(unittest.TestCase):
    def test_passes_the_page_cursor_as_a_string_parameter(self):
        database_cursor = FakeCursor()
        with patch(
            "yukisaki_api.repository._connect",
            return_value=FakeConnection(database_cursor),
        ):
            rows = PostgresMapRepository().road_segments(
                (138.8, 37.4, 138.9, 37.5),
                250,
                "road-250",
            )

        self.assertEqual([], rows)
        self.assertEqual((138.8, 37.4, 138.9, 37.5), database_cursor.parameters[:4])
        self.assertEqual(0, database_cursor.parameters[4])
        self.assertEqual("road-250", database_cursor.parameters[5])
        self.assertEqual(251, database_cursor.parameters[6])
        self.assertEqual(ROAD_SEGMENTS_SQL, database_cursor.sql)
        self.assertIn("spatial_candidate_ids", database_cursor.sql)
        self.assertIn("&& box(point(%s, %s), point(%s, %s))", database_cursor.sql)

    def test_map_view_uses_lightweight_sql_without_detail_joins(self):
        database_cursor = FakeCursor()
        with patch(
            "yukisaki_api.repository._connect",
            return_value=FakeConnection(database_cursor),
        ):
            PostgresMapRepository().road_segments(
                (138.8, 37.4, 138.9, 37.5),
                3000,
                map_only=True,
                min_road_rank=3,
            )

        self.assertEqual(ROAD_MAP_SEGMENTS_SQL, database_cursor.sql)
        self.assertEqual(3, database_cursor.parameters[4])
        self.assertIn("spatial_candidate_ids", database_cursor.sql)
        self.assertIn("END >= %s", database_cursor.sql)
        self.assertNotIn("score.factors", database_cursor.sql)
        self.assertNotIn("snowplow_segment_passages", database_cursor.sql)

    def test_snowplows_reads_from_dynamodb_and_defaults_display_name_to_vehicle_id(self):
        items = [
            {
                "vehicle_id": "snowplow-02", "latitude": Decimal("37.44"), "longitude": Decimal("138.79"),
                "speed_kmh": Decimal("18"), "heading_degrees": Decimal("90"), "accuracy_m": Decimal("5"),
                "operation": "snow_removal", "observed_at": "2026-01-23T12:00:00+09:00",
                "received_at": "2026-01-23T12:00:05+09:00", "run_id": "gps-sim-1", "is_simulated": True,
            },
            {
                "vehicle_id": "snowplow-01", "latitude": Decimal("37.45"), "longitude": Decimal("138.80"),
                "speed_kmh": Decimal("15"), "heading_degrees": Decimal("180"), "accuracy_m": Decimal("5"),
                "operation": "moving", "observed_at": "2026-01-23T12:00:00+09:00",
                "received_at": "2026-01-23T12:00:05+09:00", "run_id": "gps-sim-1", "is_simulated": True,
            },
        ]
        with patch(
            "yukisaki_api.repository._snowplow_live_table",
            return_value=FakeSnowplowLiveTable(items),
        ):
            rows = PostgresMapRepository().snowplows()

        self.assertEqual(["snowplow-01", "snowplow-02"], [row["vehicle_id"] for row in rows])
        self.assertEqual("snowplow-01", rows[0]["display_name"])
        self.assertNotIn("matched_segment_id", rows[0])
        # DynamoDB's Decimal must become plain float: GeoJSON coordinates are numbers.
        self.assertEqual(37.45, rows[0]["latitude"])
        self.assertIsInstance(rows[0]["latitude"], float)
        self.assertIsInstance(rows[0]["longitude"], float)


if __name__ == "__main__":
    unittest.main()
