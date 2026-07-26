from __future__ import annotations

import unittest
from unittest.mock import patch

from yukisaki_api.repository import (
    ROAD_MAP_SEGMENTS_SQL,
    ROAD_SEGMENTS_SQL,
    PostgresMapRepository,
)


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
        self.assertEqual("road-250", database_cursor.parameters[4])
        self.assertEqual(251, database_cursor.parameters[5])
        self.assertEqual(ROAD_SEGMENTS_SQL, database_cursor.sql)

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
            )

        self.assertEqual(ROAD_MAP_SEGMENTS_SQL, database_cursor.sql)
        self.assertNotIn("score.factors", database_cursor.sql)
        self.assertNotIn("snowplow_segment_passages", database_cursor.sql)


if __name__ == "__main__":
    unittest.main()
