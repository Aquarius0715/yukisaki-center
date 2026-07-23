import unittest
from datetime import datetime

from gps_simulator.main import build_event
from gps_simulator.route import build_routes, sample_route


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.roads = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"segment_id": f"s-{index}"},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[138.79 + index * 0.001, 37.44], [138.791 + index * 0.001, 37.44]],
                    },
                }
                for index in range(15)
            ],
        }

    def test_builds_three_routes_and_samples_on_a_segment(self):
        routes = build_routes(self.roads, center=(138.79, 37.44), vehicle_count=3)
        self.assertEqual(len(routes), 3)
        self.assertEqual(
            {edge.segment_id for route in routes for edge in route},
            {f"s-{index}" for index in range(15)},
        )
        lengths = [sum(edge.length_m for edge in route) for route in routes]
        self.assertLessEqual(max(lengths) - min(lengths), max(edge.length_m for edge in routes[0]))
        position = sample_route(routes[0], 10)
        self.assertEqual(position.segment_id, "s-0")
        self.assertGreater(position.longitude, 138.79)

    def test_event_is_explicitly_simulated(self):
        position = sample_route(build_routes(self.roads, center=(138.79, 37.44))[0], 1)
        event = build_event(
            run_id="gps-sim-test", vehicle_id="snowplow-01",
            observed_at=datetime.fromisoformat("2026-01-23T12:00:00+09:00"),
            position=position, speed_kmh=18,
        )
        self.assertTrue(event["is_simulated"])
        self.assertEqual(event["ground_truth_segment_id"], "s-0")


if __name__ == "__main__":
    unittest.main()
