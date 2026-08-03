import unittest
from datetime import datetime, timedelta

from route_planning import departure_advisor
from route_planning.config import DEPARTURE_CANDIDATE_OFFSETS_MINUTES, DEPARTURE_NO_HISTORY_ELAPSED_MINUTES

REFERENCE_TIME = datetime.fromisoformat("2026-01-23T12:00:00+09:00")


def make_edge(segment_id, observed_at):
    return {"segment_id": segment_id, "observed_at": observed_at}


class WeakSegmentIdsTest(unittest.TestCase):
    def test_segment_plowed_within_60_minutes_is_not_weak(self):
        path = [make_edge("a", REFERENCE_TIME - timedelta(minutes=30))]
        self.assertEqual([], departure_advisor.weak_segment_ids(path, REFERENCE_TIME))

    def test_segment_plowed_over_60_minutes_ago_is_weak(self):
        path = [make_edge("a", REFERENCE_TIME - timedelta(minutes=90))]
        self.assertEqual(["a"], departure_advisor.weak_segment_ids(path, REFERENCE_TIME))

    def test_segment_with_no_plow_history_is_weak(self):
        path = [make_edge("a", None)]
        self.assertEqual(["a"], departure_advisor.weak_segment_ids(path, REFERENCE_TIME))

    def test_duplicate_segment_ids_are_deduplicated_in_order(self):
        path = [
            make_edge("a", None),
            make_edge("b", REFERENCE_TIME - timedelta(minutes=90)),
            make_edge("a", None),
        ]
        self.assertEqual(["a", "b"], departure_advisor.weak_segment_ids(path, REFERENCE_TIME))


class BuildTrainingSamplesTest(unittest.TestCase):
    def test_segment_with_single_passage_contributes_no_samples(self):
        features, labels = departure_advisor.build_training_samples({"a": [REFERENCE_TIME]})
        self.assertEqual([], features)
        self.assertEqual([], labels)

    def test_gap_shorter_than_fresh_window_produces_positive_labels_near_the_next_pass(self):
        # A 30-minute gap means, when sampled just before the second pass, a
        # 0-minute-ahead check should already count the upcoming pass as
        # imminent under some offsets, and definitely once elapsed_future <= 60.
        first = REFERENCE_TIME
        second = REFERENCE_TIME + timedelta(minutes=30)
        features, labels = departure_advisor.build_training_samples({"a": [first, second]})
        self.assertTrue(features)
        self.assertEqual(len(features), len(labels))
        self.assertTrue(any(label == 1 for label in labels))
        for elapsed, horizon in features:
            self.assertGreaterEqual(elapsed, 0.0)
            self.assertIn(horizon, [float(o) for o in DEPARTURE_CANDIDATE_OFFSETS_MINUTES])


class LogisticRegressionTest(unittest.TestCase):
    def test_predict_is_bounded_and_monotonic_with_horizon(self):
        # Longer elapsed-without-a-pass and a longer wait should both make a
        # pass more likely than the equivalent shorter case, for data that
        # cleanly separates on those axes.
        features = []
        labels = []
        for elapsed in (5.0, 50.0, 100.0, 150.0):
            for horizon in (0.0, 30.0, 60.0, 90.0):
                label = 1 if (elapsed + horizon) >= 90 else 0
                features.append((elapsed, horizon))
                labels.append(label)

        model = departure_advisor.fit_logistic_regression(features, labels, iterations=300)

        low = model.predict(5.0, 0.0)
        high = model.predict(5.0, 90.0)
        self.assertGreaterEqual(low, 0.0)
        self.assertLessEqual(low, 1.0)
        self.assertGreaterEqual(high, 0.0)
        self.assertLessEqual(high, 1.0)
        self.assertLess(low, high)

    def test_fit_rejects_mismatched_lengths(self):
        with self.assertRaises(ValueError):
            departure_advisor.fit_logistic_regression([(1.0, 2.0)], [])

    def test_max_observed_elapsed_tracks_training_data_and_gates_covers(self):
        features = [(5.0, 0.0), (12.0, 30.0), (7.0, 60.0)]
        labels = [1, 0, 1]

        model = departure_advisor.fit_logistic_regression(features, labels, iterations=10)

        self.assertEqual(12.0, model.max_observed_elapsed_minutes)
        self.assertTrue(model.covers(12.0))
        self.assertFalse(model.covers(12.1))


class RecommendDepartureTest(unittest.TestCase):
    def _model(self, *, max_elapsed=250.0):
        features = []
        labels = []
        for elapsed in (10.0, 70.0, 130.0, 200.0, max_elapsed):
            for horizon in (float(o) for o in DEPARTURE_CANDIDATE_OFFSETS_MINUTES):
                label = 1 if (elapsed + horizon) >= 120 else 0
                features.append((elapsed, horizon))
                labels.append(label)
        return departure_advisor.fit_logistic_regression(features, labels, iterations=300)

    def test_recommendation_picks_an_advertised_candidate_offset(self):
        model = self._model()
        recommendation = departure_advisor.recommend_departure(
            model, ["seg-1"], {}, REFERENCE_TIME,
        )
        self.assertFalse(recommendation["insufficient_data"])
        self.assertEqual(
            len(DEPARTURE_CANDIDATE_OFFSETS_MINUTES), len(recommendation["candidates"]),
        )
        self.assertIn(
            recommendation["recommended_offset_minutes"], DEPARTURE_CANDIDATE_OFFSETS_MINUTES,
        )
        expected_time = REFERENCE_TIME + timedelta(minutes=recommendation["recommended_offset_minutes"])
        self.assertEqual(expected_time.isoformat(), recommendation["recommended_departure_time"])
        for candidate in recommendation["candidates"]:
            self.assertGreaterEqual(candidate["minimum_plow_probability"], 0.0)
            self.assertLessEqual(candidate["minimum_plow_probability"], 1.0)

    def test_missing_passage_uses_no_history_sentinel_when_in_range(self):
        # The sentinel (240) is comfortably below this model's training max
        # (250), so it's a legitimate in-range prediction, not extrapolation.
        model = self._model(max_elapsed=250.0)
        recommendation = departure_advisor.recommend_departure(
            model, ["seg-without-history"], {}, REFERENCE_TIME,
        )
        self.assertFalse(recommendation["insufficient_data"])
        self.assertEqual(240.0, DEPARTURE_NO_HISTORY_ELAPSED_MINUTES)

    def test_elapsed_beyond_training_range_reports_insufficient_data_not_a_guess(self):
        # This is the bug we hit in production: a model trained on a narrow
        # burst of short gaps (max ~8 minutes observed) was asked to predict
        # for a segment with no plow history at all (sentinel 240 minutes).
        # Extrapolating a linear model that far outside its training domain
        # saturates the sigmoid toward 0 or 1 for reasons that have nothing
        # to do with the real world, so it must not be reported as a number.
        model = self._model(max_elapsed=8.0)
        recommendation = departure_advisor.recommend_departure(
            model, ["seg-without-history"], {}, REFERENCE_TIME,
        )
        self.assertTrue(recommendation["insufficient_data"])
        self.assertEqual([], recommendation["candidates"])
        self.assertEqual(["seg-without-history"], recommendation["evaluated_segment_ids"])

    def test_elapsed_within_training_range_is_not_flagged(self):
        model = self._model(max_elapsed=250.0)
        latest_passages = {"seg-1": REFERENCE_TIME - timedelta(minutes=100)}
        recommendation = departure_advisor.recommend_departure(
            model, ["seg-1"], latest_passages, REFERENCE_TIME,
        )
        self.assertFalse(recommendation["insufficient_data"])

    def test_no_wait_needed_response_recommends_reference_time_itself(self):
        response = departure_advisor.no_wait_needed_response(REFERENCE_TIME)
        self.assertEqual(0, response["recommended_offset_minutes"])
        self.assertEqual(REFERENCE_TIME.isoformat(), response["recommended_departure_time"])
        self.assertTrue(response["meets_probability_threshold"])
        self.assertFalse(response["insufficient_data"])

    def test_insufficient_data_response_still_names_evaluated_segments(self):
        response = departure_advisor.insufficient_data_response(REFERENCE_TIME, ["a", "b"])
        self.assertTrue(response["insufficient_data"])
        self.assertEqual(["a", "b"], response["evaluated_segment_ids"])
        self.assertEqual([], response["candidates"])


if __name__ == "__main__":
    unittest.main()
