import unittest
from datetime import datetime, timedelta

from data_processing.weather.window_loader import FIELDS, normalize_window


def response(reference):
    times = [(reference + timedelta(hours=offset)).strftime("%Y-%m-%dT%H:00") for offset in range(-3, 4)]
    hourly = {"time": times}
    for field in FIELDS:
        hourly[field] = list(range(7))
    return {"hourly": hourly}


class WeatherWindowLoaderTest(unittest.TestCase):
    def test_builds_observed_and_forecast_window(self):
        reference = datetime.fromisoformat("2026-01-23T12:00:00+09:00")
        raw = {
            "schema_version": "2.0.0",
            "location": {"location_id": "nagaoka-isuruginami-minami", "name": "石動南町", "latitude": 37.442762, "longitude": 138.790865},
            "reference_time": reference.isoformat(),
            "fetched_at": "2026-07-14T00:00:00+00:00",
            "run_id": "run-1",
            "sources": {
                "observation": {"url": "https://observation.example", "response": response(reference)},
                "forecast": {"url": "https://forecast.example", "response": response(reference)},
            },
        }
        records = normalize_window(raw)
        self.assertEqual([record["relative_hour"] for record in records], [-3, -2, -1, 0, 1, 2, 3])
        self.assertEqual([record["data_kind"] for record in records], ["observed"] * 4 + ["forecast"] * 3)
        self.assertFalse(any(record["is_simulated"] for record in records))


if __name__ == "__main__":
    unittest.main()
