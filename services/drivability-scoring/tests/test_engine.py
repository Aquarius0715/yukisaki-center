import unittest

from drivability_scoring.engine import score_segment


class ScoringTest(unittest.TestCase):
    def test_applies_deterministic_penalties(self):
        result = score_segment({
            "segment_id": "s-1", "snowfall_1h_cm": 3, "max_slope_percent": 5,
            "last_plowed_at": "2026-01-23T11:30:00+09:00", "snow_pipe": True,
            "snow_pipe_operation_status": "active", "temperature_c": -1,
            "data_timestamp": "2026-01-23T12:00:00+09:00", "is_simulated": True,
        })
        self.assertEqual(result["score"], 80)
        self.assertEqual(result["confidence"], 1.0)

    def test_penalizes_missing_plow_history_without_inventing_it(self):
        result = score_segment({
            "segment_id": "s-2", "snowfall_1h_cm": 0, "max_slope_percent": 9,
            "last_plowed_at": None, "snow_pipe": False,
            "snow_pipe_operation_status": "inactive", "temperature_c": -5,
            "data_timestamp": "2026-01-23T12:00:00+09:00", "is_simulated": True,
        })
        self.assertEqual(result["score"], 65)
        self.assertIn("no_plow_history", result["factors"])


if __name__ == "__main__":
    unittest.main()
