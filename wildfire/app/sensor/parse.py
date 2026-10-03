"""Parse the Arduino GET /api/sensor JSON body."""

from __future__ import annotations

import math
from dataclasses import dataclass

TEMPERATURE_MIN_C = -20.0
TEMPERATURE_MAX_C = 60.0
HUMIDITY_MIN = 0.0
HUMIDITY_MAX = 100.0


class SensorParseError(ValueError):
    """The body was JSON but not a usable sensor reading."""


class SensorReadFailure(SensorParseError):
    """The Arduino responded, and the sensor itself failed to read."""


@dataclass(frozen=True)
class SensorReading:
    temperature_c: float
    humidity_pct: float


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or isinstance(value, str) or value is None:
        raise SensorParseError(f"{name} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise SensorParseError(f"{name} must be a number") from exc
    if not math.isfinite(number):
        raise SensorParseError(f"{name} must be a finite number")
    return number


def _unit_is_celsius(unit: object) -> bool:
    if unit is None:
        return True
    if not isinstance(unit, str):
        return False
    normalized = unit.strip().upper().replace("°", "")
    return normalized in {"C", "CELSIUS"}


def parse_sensor_payload(payload: object) -> SensorReading:
    if not isinstance(payload, dict):
        raise SensorParseError("Sensor JSON must be an object")
    if payload.get("ok") is False or payload.get("error") == "dht_read_failure":
        message = payload.get("error") or "dht_read_failure"
        raise SensorReadFailure(str(message))
    if "temperature" not in payload or "humidity" not in payload:
        raise SensorParseError("temperature and humidity are required")
    if not _unit_is_celsius(payload.get("unit", "C")):
        raise SensorParseError("temperature unit must be C")

    temperature = _number(payload.get("temperature"), "temperature")
    humidity = _number(payload.get("humidity"), "humidity")
    if not TEMPERATURE_MIN_C <= temperature <= TEMPERATURE_MAX_C:
        raise SensorParseError("temperature is outside the accepted range")
    if not HUMIDITY_MIN <= humidity <= HUMIDITY_MAX:
        raise SensorParseError("humidity is outside 0 to 100 percent")
    return SensorReading(temperature_c=temperature, humidity_pct=humidity)
