"""HTTP fetch of the Arduino sensor endpoint."""

from __future__ import annotations

import json
from dataclasses import dataclass

import httpx

from app.sensor.parse import SensorParseError, SensorReadFailure, parse_sensor_payload

MAX_SENSOR_BYTES = 8192


@dataclass(frozen=True)
class FetchResult:
    status: str
    temperature_c: float | None = None
    humidity_pct: float | None = None
    error: str | None = None


async def fetch_sensor(client: httpx.AsyncClient, url: str) -> FetchResult:
    """Return a result for every network outcome. Callers keep running either way."""
    try:
        async with client.stream("GET", url, follow_redirects=False) as response:
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_SENSOR_BYTES:
                    return FetchResult(status="malformed", error="Sensor response was too large")
                chunks.append(chunk)
            status_code = response.status_code
    except httpx.TimeoutException:
        return FetchResult(status="timeout", error="HTTP timeout while contacting the Arduino")
    except httpx.HTTPError:
        return FetchResult(status="offline", error="Arduino unreachable")
    except OSError:
        return FetchResult(status="offline", error="Arduino unreachable")

    body = b"".join(chunks).strip()
    if not body:
        if status_code != 200:
            return FetchResult(status="http_error", error=f"Arduino returned HTTP {status_code}")
        return FetchResult(status="malformed", error="Sensor response was empty")

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        if status_code != 200:
            return FetchResult(status="http_error", error=f"Arduino returned HTTP {status_code}")
        return FetchResult(
            status="malformed",
            error="Response was not JSON. The Arduino should expose GET /api/sensor.",
        )

    if isinstance(payload, dict) and (
        payload.get("ok") is False or payload.get("error") == "dht_read_failure"
    ):
        message = payload.get("error") or "dht_read_failure"
        return FetchResult(status="read_failure", error=str(message))

    if status_code != 200:
        return FetchResult(status="http_error", error=f"Arduino returned HTTP {status_code}")

    try:
        reading = parse_sensor_payload(payload)
    except SensorReadFailure as exc:
        return FetchResult(status="read_failure", error=str(exc))
    except SensorParseError as exc:
        return FetchResult(status="invalid", error=str(exc))

    return FetchResult(
        status="ok",
        temperature_c=reading.temperature_c,
        humidity_pct=reading.humidity_pct,
    )
