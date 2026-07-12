"""Small dependency-free REST API shell for the demo serving boundary."""

from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ApiHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.respond(HTTPStatus.OK, {"status": "ok"})
        elif self.path.startswith("/v1/road-segments"):
            self.respond(HTTPStatus.OK, {"type": "FeatureCollection", "features": [], "data_timestamp": "2026-01-23T00:00:00+09:00", "is_simulated": True})
        else:
            self.respond(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def respond(self, status: HTTPStatus, body: dict) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def serve(port: int = 8080) -> None:
    ThreadingHTTPServer(("0.0.0.0", port), ApiHandler).serve_forever()


if __name__ == "__main__":
    serve()
