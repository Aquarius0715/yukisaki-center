import unittest

from ai_assistant.service import explain_route, extract_conditions


class AssistantTest(unittest.TestCase):
    def test_extracts_safety_intent(self):
        self.assertEqual(extract_conditions("雪道で安全な経路を教えて")["safety_priority"], "high")

    def test_explains_only_given_evidence(self):
        self.assertIn("2件", explain_route({"minimum_score": 35, "hazard_count": 2}))


if __name__ == "__main__":
    unittest.main()
