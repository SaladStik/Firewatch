"""A stand-in for the Arduino HTTP server.

Run it when the board is not connected:

    python -m app.mock_arduino

Then set ARDUINO_URL=http://127.0.0.1:8081
"""

from __future__ import annotations

import argparse
import json
import math
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def sample_reading(now: datetime | None = None) -> tuple[float, float]:
    moment = now or datetime.now(timezone.utc)
    seconds = moment.timestamp()
    temperature = 22.0 + 6.0 * math.sin(seconds / 180.0)
    humidity = 48.0 + 18.0 * math.sin(seconds / 240.0 + 0.8)
    temperature = min(35.0, max(5.0, round(temperature, 1)))
    humidity = min(90.0, max(20.0, round(humidity, 1)))
    return temperature, humidity


def sensor_body(scenario: str, now: datetime | None = None) -> tuple[int, bytes, str]:
    if scenario == "dht_failure":
        payload = {
            "ok": False,
            "error": "dht_read_failure",
            "temperature": None,
            "humidity": None,
            "unit": "C",
        }
        return 503, json.dumps(payload).encode("utf-8"), "application/json"
    if scenario == "invalid":
        payload = {"temperature": 23.0, "humidity": 250, "unit": "C"}
        return 200, json.dumps(payload).encode("utf-8"), "application/json"
    if scenario == "malformed":
        return 200, b"temperature=hot", "text/plain"
    temperature, humidity = sample_reading(now)
    payload = {"temperature": temperature, "humidity": humidity, "unit": "C"}
    return 200, json.dumps(payload).encode("utf-8"), "application/json"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler name
        parsed = urlparse(self.path)
        scenario = parse_qs(parsed.query).get("scenario", [getattr(self.server, "scenario", "ok")])[0]
        if parsed.path == "/api/sensor":
            status, body, content_type = sensor_body(scenario)
            self._send(status, content_type, body)
            return
        if parsed.path in {"/", "/index.html"}:
            page = (
                "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Mock DHT11</title></head>"
                "<body><h1>Mock Arduino DHT11</h1>"
                "<p>This stand-in serves the human page and JSON at /api/sensor.</p>"
                "</body></html>"
            ).encode("utf-8")
            self._send(200, "text/html; charset=utf-8", page)
            return
        self._send(404, "text/plain; charset=utf-8", b"not found")

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


class MockArduino:
    def __init__(self, host: str = "127.0.0.1", port: int = 0, scenario: str = "ok"):
        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.httpd.scenario = scenario
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return int(self.httpd.server_address[1])

    @property
    def base_url(self) -> str:
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    def start(self) -> MockArduino:
        self.thread.start()
        return self

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)


def main() -> None:
    parser = argparse.ArgumentParser(description="Mock Arduino DHT11 HTTP server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument(
        "--scenario",
        default="ok",
        choices=["ok", "dht_failure", "malformed", "invalid"],
    )
    args = parser.parse_args()
    server = MockArduino(args.host, args.port, args.scenario).start()
    print(f"Mock Arduino at {server.base_url}/api/sensor ({args.scenario})")
    try:
        server.thread.join()
    except KeyboardInterrupt:
        server.close()


if __name__ == "__main__":
    main()
