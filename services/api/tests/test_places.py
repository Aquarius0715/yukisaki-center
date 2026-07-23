from __future__ import annotations

import json
import unittest

from yukisaki_api.places import (
    AppleMapsTokenProvider,
    PlaceQuery,
    PlaceSearchService,
)
from yukisaki_api.places_handler import handle


class FakeClient:
    def get(self, endpoint, query):
        self.endpoint = endpoint
        self.query = query
        if endpoint == "/v1/searchAutocomplete":
            return {
                "results": [
                    {
                        "displayLines": ["長岡駅", "新潟県長岡市"],
                        "completionUrl": "/v1/search?q=%E9%95%B7%E5%B2%A1%E9%A7%85&metadata=opaque",
                        "location": {"latitude": 37.4477, "longitude": 138.8530},
                    }
                ]
            }
        return {
            "results": [
                {
                    "name": "長岡駅",
                    "formattedAddressLines": ["新潟県長岡市城内町"],
                    "countryCode": "JP",
                    "coordinate": {"latitude": 37.4477, "longitude": 138.8530},
                },
                {
                    "name": "新潟駅",
                    "coordinate": {"latitude": 37.912, "longitude": 139.061},
                },
            ]
        }


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


def event(path, query="長岡駅"):
    return {
        "rawPath": path,
        "queryStringParameters": {"q": query},
        "requestContext": {"http": {"method": "GET", "path": path}},
    }


class PlaceSearchTest(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        self.service = PlaceSearchService(self.client)

    def test_search_normalizes_and_restricts_results_to_nagaoka(self):
        response = handle(event("/v1/places/search"), self.service)
        body = json.loads(response["body"])
        self.assertEqual(200, response["statusCode"])
        self.assertEqual(1, body["count"])
        self.assertEqual("長岡駅", body["results"][0]["name"])
        self.assertEqual("apple_maps", body["provider"])
        self.assertFalse(body["is_simulated"])
        self.assertEqual("required", self.client.query["searchRegionPriority"])
        self.assertIn("searchRegion", self.client.query)
        self.assertNotIn("searchLocation", self.client.query)

    def test_autocomplete_hides_opaque_metadata(self):
        body = json.loads(
            handle(event("/v1/places/autocomplete", "長岡"), self.service)["body"]
        )
        self.assertEqual("長岡駅", body["results"][0]["query"])
        self.assertNotIn("completionUrl", body["results"][0])

    def test_short_query_is_rejected(self):
        self.assertEqual(
            400, handle(event("/v1/places/search", "a"), self.service)["statusCode"]
        )

    def test_server_jwt_is_exchanged_for_a_cached_access_token(self):
        encoded = []
        requests = []

        def encoder(payload, key, **kwargs):
            encoded.append((payload, key, kwargs))
            return "auth-token"

        def opener(request, timeout):
            requests.append((request, timeout))
            return FakeResponse(
                {"accessToken": "maps-access-token", "expiresInSeconds": 1800}
            )

        provider = AppleMapsTokenProvider(
            lambda: {
                "team_id": "TEAM123456",
                "key_id": "KEY1234567",
                "private_key": "private",
            },
            encoder=encoder,
            clock=lambda: 1000,
            opener=opener,
        )
        self.assertEqual("maps-access-token", provider.token())
        self.assertEqual("maps-access-token", provider.token())
        self.assertEqual(1, len(encoded))
        self.assertEqual(1, len(requests))
        self.assertEqual("server_api", encoded[0][0]["scope"])
        self.assertEqual(1900, encoded[0][0]["exp"])
        self.assertEqual("ES256", encoded[0][2]["algorithm"])
        self.assertTrue(requests[0][0].full_url.endswith("/v1/token"))
        self.assertEqual(
            "Bearer auth-token", requests[0][0].get_header("Authorization")
        )


if __name__ == "__main__":
    unittest.main()
