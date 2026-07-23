from __future__ import annotations

import unittest
from unittest.mock import patch

from yukisaki_api.repository import PostgresMapRepository


class FakeCursor:
    description = []

    def __init__(self):
        self.parameters = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, _sql, parameters):
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


if __name__ == "__main__":
    unittest.main()
