import unittest
import hashlib
import io
import json
from datetime import datetime, timedelta

from data_processing.weather.window_loader import (
    FIELDS,
    normalize_window,
    parse_verified_raw,
    snapshot_scope,
)


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

    def test_builds_window_for_every_city_grid_location(self):
        reference = datetime.fromisoformat("2026-01-23T12:00:00+09:00")
        raw = {
            "schema_version": "3.0.0",
            "reference_time": reference.isoformat(),
            "fetched_at": "2026-07-23T00:00:00+00:00",
            "run_id": "run-city",
            "source_urls": ["https://observation.example", "https://forecast.example"],
            "locations": [
                {
                    "location": {
                        "location_id": f"nagaoka-grid-r01-c0{index}",
                        "name": f"grid-{index}",
                        "latitude": 37.2 + index / 10,
                        "longitude": 138.7 + index / 10,
                    },
                    "sources": {
                        "observation": {
                            "url": "https://observation.example",
                            "response": response(reference),
                        },
                        "forecast": {
                            "url": "https://forecast.example",
                            "response": response(reference),
                        },
                    },
                }
                for index in range(1, 3)
            ],
        }
        records = normalize_window(raw)
        self.assertEqual(len(records), 14)
        self.assertEqual(len({record["location_id"] for record in records}), 2)
        reference_time, location_ids = snapshot_scope(records)
        self.assertEqual(reference_time, reference.isoformat())
        self.assertEqual(location_ids, ["nagaoka-grid-r01-c01", "nagaoka-grid-r01-c02"])

    def test_verifies_the_s3_raw_checksum_before_parsing(self):
        body = json.dumps({"run_id": "run-1"}).encode()
        checksum = hashlib.sha256(body).hexdigest()
        payload, actual_checksum = parse_verified_raw({
            "Body": io.BytesIO(body),
            "Metadata": {"sha256": checksum},
        })
        self.assertEqual(payload["run_id"], "run-1")
        self.assertEqual(actual_checksum, checksum)

        with self.assertRaises(ValueError):
            parse_verified_raw({"Body": io.BytesIO(body), "Metadata": {"sha256": "invalid"}})


if __name__ == "__main__":
    unittest.main()
