import unittest

from route_planning.engine import find_route


class RoutePlanningTest(unittest.TestCase):
    def test_chooses_lowest_cost_route(self):
        route = find_route([
            {"from": "a", "to": "b", "segment_id": "ab", "cost": 2},
            {"from": "b", "to": "c", "segment_id": "bc", "cost": 2},
            {"from": "a", "to": "c", "segment_id": "ac", "cost": 9},
        ], "a", "c")
        self.assertEqual(route["segment_ids"], ["ab", "bc"])


if __name__ == "__main__":
    unittest.main()
