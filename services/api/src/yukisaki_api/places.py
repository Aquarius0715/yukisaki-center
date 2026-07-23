"""Apple Maps Server API place search with a stable Yukisaki response contract."""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

NAGAOKA_BBOX = (138.643056, 37.176389, 139.124444, 37.710278)
APPLE_MAPS_BASE_URL = "https://maps-api.apple.com"


class PlaceRequestError(ValueError):
    """Safe client-input error."""


class PlaceProviderError(RuntimeError):
    """Safe upstream/configuration failure."""

    def __init__(self, code: str, status: int = 503):
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class PlaceQuery:
    text: str

    @classmethod
    def parse(cls, params: dict[str, str] | None) -> "PlaceQuery":
        text = ((params or {}).get("q") or "").strip()
        if len(text) < 2:
            raise PlaceRequestError("q must contain at least 2 characters")
        if len(text) > 100 or any(ord(char) < 32 for char in text):
            raise PlaceRequestError("q is invalid")
        return cls(text=text)


class AppleMapsTokenProvider:
    """Exchanges a signed server_api JWT for a cached Maps access token."""

    def __init__(
        self,
        secret_loader: Callable[[], dict[str, str]],
        encoder: Callable[..., str] | None = None,
        clock: Callable[[], float] = time.time,
        opener: Callable[..., Any] = urlopen,
        base_url: str = APPLE_MAPS_BASE_URL,
    ):
        self.secret_loader = secret_loader
        self.encoder = encoder
        self.clock = clock
        self.opener = opener
        self.base_url = base_url.rstrip("/")
        self._token: str | None = None
        self._expires_at = 0

    def token(self) -> str:
        now = int(self.clock())
        if self._token and now < self._expires_at - 60:
            return self._token
        credentials = self.secret_loader()
        required = ("team_id", "key_id", "private_key")
        if any(not credentials.get(field) for field in required):
            raise PlaceProviderError("apple_maps_credentials_invalid")
        encoder = self.encoder
        if encoder is None:
            import jwt

            encoder = jwt.encode
        auth_token = encoder(
            {
                "iss": credentials["team_id"],
                "iat": now,
                "exp": now + 900,
                "scope": "server_api",
            },
            credentials["private_key"],
            algorithm="ES256",
            headers={"kid": credentials["key_id"], "typ": "JWT"},
        )
        request = Request(
            f"{self.base_url}/v1/token",
            headers={
                "Authorization": f"Bearer {auth_token}",
                "Accept": "application/json",
                "User-Agent": "yukisaki-center/1.0",
            },
        )
        try:
            with self.opener(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            if error.code == 401:
                raise PlaceProviderError("apple_maps_credentials_invalid") from error
            if error.code == 429:
                raise PlaceProviderError("apple_maps_rate_limited", 429) from error
            raise PlaceProviderError("apple_maps_upstream_error", 502) from error
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            raise PlaceProviderError("apple_maps_upstream_error", 502) from error
        access_token = payload.get("accessToken") if isinstance(payload, dict) else None
        expires_in = payload.get("expiresInSeconds") if isinstance(payload, dict) else None
        if not isinstance(access_token, str) or not access_token:
            raise PlaceProviderError("apple_maps_invalid_response", 502)
        if not isinstance(expires_in, (int, float)) or expires_in <= 0:
            raise PlaceProviderError("apple_maps_invalid_response", 502)
        self._token = access_token
        self._expires_at = now + int(expires_in)
        return self._token


def load_apple_maps_secret() -> dict[str, str]:
    secret_arn = os.environ.get("APPLE_MAPS_SECRET_ARN")
    if not secret_arn:
        raise PlaceProviderError("apple_maps_not_configured")
    import boto3

    response = boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn)
    try:
        value = json.loads(response["SecretString"])
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise PlaceProviderError("apple_maps_credentials_invalid") from error
    if not isinstance(value, dict):
        raise PlaceProviderError("apple_maps_credentials_invalid")
    return value


class AppleMapsClient:
    def __init__(
        self,
        token_provider: AppleMapsTokenProvider,
        opener: Callable[..., Any] = urlopen,
        base_url: str = APPLE_MAPS_BASE_URL,
    ):
        self.token_provider = token_provider
        self.opener = opener
        self.base_url = base_url.rstrip("/")

    def get(self, endpoint: str, query: dict[str, str]) -> dict[str, Any]:
        request = Request(
            f"{self.base_url}{endpoint}?{urlencode(query)}",
            headers={
                "Authorization": f"Bearer {self.token_provider.token()}",
                "Accept": "application/json",
                "User-Agent": "yukisaki-center/1.0",
            },
        )
        try:
            with self.opener(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            if error.code == 429:
                raise PlaceProviderError("apple_maps_rate_limited", 429) from error
            raise PlaceProviderError("apple_maps_upstream_error", 502) from error
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            raise PlaceProviderError("apple_maps_upstream_error", 502) from error
        if not isinstance(payload, dict):
            raise PlaceProviderError("apple_maps_invalid_response", 502)
        return payload


def _common_query(text: str) -> dict[str, str]:
    west, south, east, north = NAGAOKA_BBOX
    return {
        "q": text,
        "lang": "ja-JP",
        "limitToCountries": "JP",
        "searchRegion": f"{north},{east},{south},{west}",
        "searchRegionPriority": "required",
    }


def _inside_nagaoka(latitude: Any, longitude: Any) -> bool:
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        return False
    west, south, east, north = NAGAOKA_BBOX
    return west <= longitude <= east and south <= latitude <= north


def _result_id(name: str, latitude: float, longitude: float) -> str:
    value = f"apple_maps:{name}:{latitude:.7f}:{longitude:.7f}".encode()
    return hashlib.sha256(value).hexdigest()[:24]


class PlaceSearchService:
    def __init__(self, client: AppleMapsClient):
        self.client = client

    def search(self, query: PlaceQuery) -> dict[str, Any]:
        payload = self.client.get("/v1/search", _common_query(query.text))
        places = []
        for result in payload.get("results") or []:
            coordinate = result.get("coordinate") or {}
            latitude = coordinate.get("latitude")
            longitude = coordinate.get("longitude")
            if not _inside_nagaoka(latitude, longitude):
                continue
            name = str(result.get("name") or "").strip()
            if not name:
                continue
            address_lines = [
                str(line) for line in (result.get("formattedAddressLines") or []) if line
            ]
            places.append(
                {
                    "place_id": _result_id(name, latitude, longitude),
                    "name": name,
                    "address": " ".join(address_lines),
                    "latitude": latitude,
                    "longitude": longitude,
                    "country_code": result.get("countryCode"),
                    "provider": "apple_maps",
                    "confidence": None,
                    "is_simulated": False,
                }
            )
        return self._envelope(query.text, places)

    def autocomplete(self, query: PlaceQuery) -> dict[str, Any]:
        payload = self.client.get("/v1/searchAutocomplete", _common_query(query.text))
        suggestions = []
        for result in payload.get("results") or []:
            lines = [str(line) for line in (result.get("displayLines") or []) if line]
            if not lines:
                continue
            location = result.get("location") or {}
            latitude = location.get("latitude")
            longitude = location.get("longitude")
            if (latitude is not None or longitude is not None) and not _inside_nagaoka(
                latitude, longitude
            ):
                continue
            completion_query = parse_qs(
                urlparse(str(result.get("completionUrl") or "")).query
            ).get("q", [lines[0]])[0]
            suggestions.append(
                {
                    "name": lines[0],
                    "subtitle": " ".join(lines[1:]),
                    "query": completion_query,
                    "latitude": latitude,
                    "longitude": longitude,
                    "provider": "apple_maps",
                    "is_simulated": False,
                }
            )
        return self._envelope(query.text, suggestions)

    @staticmethod
    def _envelope(query: str, results: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "query": query,
            "results": results,
            "count": len(results),
            "search_region": {
                "name": "新潟県長岡市",
                "bbox": list(NAGAOKA_BBOX),
            },
            "provider": "apple_maps",
            "data_timestamp": datetime.now(timezone.utc).isoformat(),
            "confidence": None,
            "is_simulated": False,
        }
