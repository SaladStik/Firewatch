"""Parse lines from the USB sensor sketch.

The sketch prints a reading as TEMP:23.40,HUMIDITY:42.00, or ERROR.
A ready banner is ignored.
"""

from __future__ import annotations

import re

from app.sensor.client import FetchResult
from app.sensor.parse import SensorParseError, SensorReadFailure, parse_sensor_payload

_READING = re.compile(
    r"^TEMP:([+-]?\d+(?:\.\d+)?),HUMIDITY:([+-]?\d+(?:\.\d+)?)$",
    re.IGNORECASE,
)


def parse_serial_line(line: str) -> FetchResult | None:
    text = line.strip()
    if not text or text.upper() == "DHT11_READY":
        return None
    if text.upper() == "ERROR":
        return FetchResult(status="read_failure", error="dht_read_failure")
    match = _READING.fullmatch(text)
    if match is None:
        return FetchResult(status="malformed", error="Unrecognized serial line from the Arduino")
    try:
        reading = parse_sensor_payload(
            {
                "temperature": float(match.group(1)),
                "humidity": float(match.group(2)),
                "unit": "C",
            }
        )
    except SensorReadFailure as exc:
        return FetchResult(status="read_failure", error=str(exc))
    except SensorParseError as exc:
        return FetchResult(status="invalid", error=str(exc))
    return FetchResult(
        status="ok",
        temperature_c=reading.temperature_c,
        humidity_pct=reading.humidity_pct,
    )
