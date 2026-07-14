import io
import json
import unittest
from datetime import datetime

from data_ingestion.weather.window_collector import (
    HOURLY_FIELDS,
    build_source_url,
    fetch_json,
    parse_reference_time,
)


class Response:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit):
        return self.body


class WeatherWindowCollectorTest(unittest.TestCase):
    def test_reference_time_is_hour_aligned(self):
        parsed = parse_reference_time("2026-01-23T12:00:00+09:00")
        self.assertEqual(parsed.hour, 12)
        with self.assertRaises(ValueError):
            parse_reference_time("2026-01-23T12:30:00+09:00")

    def test_builds_allow_listed_url(self):
        url = build_source_url(
            "https://archive-api.open-meteo.com/v1/archive",
            datetime.fromisoformat("2026-01-23T12:00:00+09:00"),
            37.442762,
            138.790865,
        )
        self.assertIn("start_date=2026-01-23", url)
        self.assertIn("timezone=Asia%2FTokyo", url)

    def test_validates_hourly_series(self):
        hourly = {"time": ["2026-01-23T12:00"]}
        hourly.update({field: [1] for field in HOURLY_FIELDS})
        payload = json.dumps({"hourly": hourly}).encode()
        result = fetch_json("https://example.test", opener=lambda *_args, **_kwargs: Response(payload))
        self.assertEqual(result["hourly"]["temperature_2m"], [1])


if __name__ == "__main__":
    unittest.main()
