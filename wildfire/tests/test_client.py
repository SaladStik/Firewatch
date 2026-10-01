import asyncio

import httpx

from app.sensor.client import fetch_sensor


def _run(handler, url="http://sensor.local/api/sensor"):
    async def scenario():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            return await fetch_sensor(client, url)

    return asyncio.run(scenario())


def test_fetch_parses_sensor_json():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/sensor"
        return httpx.Response(200, json={"temperature": 23.4, "humidity": 42.0, "unit": "C"})

    result = _run(handler)
    assert result.status == "ok"
    assert result.temperature_c == 23.4
    assert result.humidity_pct == 42.0


def test_connection_failure_is_offline():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    result = _run(handler)
    assert result.status == "offline"
    assert result.temperature_c is None


def test_timeout_is_reported():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out")

    result = _run(handler)
    assert result.status == "timeout"


def test_malformed_body():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"temperature=hot")

    result = _run(handler)
    assert result.status == "malformed"


def test_dht_failure_body():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            json={
                "ok": False,
                "error": "dht_read_failure",
                "temperature": None,
                "humidity": None,
                "unit": "C",
            },
        )

    result = _run(handler)
    assert result.status == "read_failure"


def test_invalid_sensor_values():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"temperature": 23, "humidity": 250, "unit": "C"})

    result = _run(handler)
    assert result.status == "invalid"


def test_oversized_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"{" + b"x" * 9000)

    result = _run(handler)
    assert result.status == "malformed"
    assert "large" in (result.error or "")
