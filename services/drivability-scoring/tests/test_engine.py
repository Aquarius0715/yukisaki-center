import unittest

from drivability_scoring.engine import score_segment


class ScoringTest(unittest.TestCase):
    def test_applies_deterministic_penalties(self):
        result = score_segment({"segment_id": "s-1", "snow_depth_cm": 10, "max_slope_percent": 5, "plowed": False, "snow_melting": True, "data_timestamp": "2026-01-23T00:00:00+09:00", "is_simulated": True})
        self.assertEqual(result["score"], 50)
        self.assertEqual(result["confidence"], 1.0)


if __name__ == "__main__":
    unittest.main()
