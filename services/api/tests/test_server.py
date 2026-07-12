import unittest

from server import ApiHandler


class ApiTest(unittest.TestCase):
    def test_handler_is_available(self):
        self.assertTrue(issubclass(ApiHandler, object))


if __name__ == "__main__":
    unittest.main()
