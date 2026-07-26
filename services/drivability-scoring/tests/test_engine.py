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

    def test_penalizes_residential_road_as_narrow(self):
        result = score_segment({
            "segment_id": "s-3", "snowfall_1h_cm": 0, "max_slope_percent": 0,
            "road_type": "residential", "last_plowed_at": None, "snow_pipe": False,
            "snow_pipe_operation_status": "inactive", "temperature_c": None,
            "data_timestamp": "2026-01-23T12:00:00+09:00", "is_simulated": True,
        })
        self.assertEqual(result["factors"]["narrow_road"], -10)

    def test_penalizes_service_road_more_than_residential(self):
        result = score_segment({
            "segment_id": "s-4", "snowfall_1h_cm": 0, "max_slope_percent": 0,
            "road_type": "service", "last_plowed_at": None, "snow_pipe": False,
            "snow_pipe_operation_status": "inactive", "temperature_c": None,
            "data_timestamp": "2026-01-23T12:00:00+09:00", "is_simulated": True,
        })
        self.assertEqual(result["factors"]["narrow_road"], -15)

    def test_does_not_penalize_main_roads_as_narrow(self):
        result = score_segment({
            "segment_id": "s-5", "snowfall_1h_cm": 0, "max_slope_percent": 0,
            "road_type": "primary", "last_plowed_at": None, "snow_pipe": False,
            "snow_pipe_operation_status": "inactive", "temperature_c": None,
            "data_timestamp": "2026-01-23T12:00:00+09:00", "is_simulated": True,
        })
        self.assertNotIn("narrow_road", result["factors"])

    def test_road_type_does_not_affect_confidence(self):
        with_type = score_segment({
            "segment_id": "s-6", "snowfall_1h_cm": 3, "max_slope_percent": 5,
            "road_type": "residential",
            "last_plowed_at": "2026-01-23T11:30:00+09:00", "snow_pipe": True,
            "snow_pipe_operation_status": "active", "temperature_c": -1,
            "data_timestamp": "2026-01-23T12:00:00+09:00", "is_simulated": True,
        })
        self.assertEqual(with_type["confidence"], 1.0)


if __name__ == "__main__":
    unittest.main()
