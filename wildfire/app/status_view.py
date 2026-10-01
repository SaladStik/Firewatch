"""Shape the dashboard payload. Sensor readings and the model estimate stay separate."""

from __future__ import annotations

from datetime import datetime

from app.copy import (
    CATEGORY_NOTE,
    CONFIDENCE_NOTE,
    DISCLAIMER,
    MODEL_INPUTS,
    MODEL_NAME,
    MODEL_REFERENCE,
)
from app.model.factors import FACTORS
from app.model.pipeline import Assessment, assess


def sensor_label(fresh: bool, failure_kind: str | None, has_success: bool) -> str:
    if fresh:
        return "Connected"
    if failure_kind == "read_failure":
        return "Sensor read failed"
    if failure_kind in {"malformed", "invalid"}:
        return "Invalid sensor data"
    if failure_kind is None and has_success:
        return "Stale reading"
    return "Sensor offline"


def sensor_detail(
    *,
    fresh: bool,
    failure_kind: str | None,
    failure_detail: str | None,
    has_success: bool,
) -> str | None:
    if fresh and failure_kind:
        reason = failure_detail or failure_kind
        return f"Showing the last good reading. Latest attempt failed: {reason}."
    if not fresh and failure_kind is None and has_success:
        return "This reading is older than the freshness window, so it is not being used for a current estimate."
    if not fresh and failure_kind is None and not has_success:
        return "Waiting for the first reading."
    return failure_detail


def prediction_message(assessment: Assessment) -> str:
    if assessment.state == "ok":
        return ""
    if assessment.state == "missing_inputs":
        return (
            "The model did not produce a score because wind speed is missing. "
            "Temperature and humidity from the DHT11 are not sufficient on their own."
        )
    if assessment.state == "stale_sensor":
        return "The model estimate is withheld because the sensor reading is stale."
    if assessment.state == "read_failure":
        return "The model estimate is withheld because the DHT11 read failed."
    if assessment.state == "invalid_sensor":
        return "The model estimate is withheld because the sensor response was invalid."
    if assessment.state == "model_error":
        return "The model estimate is withheld because the calculation failed."
    return "The model estimate is withheld because the Arduino sensor is offline."


def _wind_source_label(origin: str | None, source: str | None) -> str:
    if origin == "dashboard":
        return source or "Dashboard entry"
    if origin == "environment":
        return "WIND_SPEED_MPH in the environment"
    if origin == "open-meteo":
        return "Open-Meteo 10 m wind"
    return "Not provided"


def build_status(
    *,
    now: datetime,
    configured: bool,
    endpoint: str | None,
    poll_interval_seconds: float,
    stale_after_seconds: float,
    connection: str | None,
    last_success_at: datetime | None,
    temperature_c: float | None,
    humidity_pct: float | None,
    failure_kind: str | None,
    failure_detail: str | None,
    wind_speed_mph: float | None,
    wind_speed_source: str | None,
    wind_origin: str | None,
    context: dict,
    latitude: float | None,
    longitude: float | None,
    supplement_error: str | None,
    config_warnings: tuple[str, ...],
    reading_fresh: bool,
) -> dict:
    has_success = last_success_at is not None and temperature_c is not None
    label = sensor_label(reading_fresh, failure_kind, has_success)
    if (
        not configured
        and not reading_fresh
        and not has_success
        and failure_kind in {None, "not_configured"}
    ):
        label = "Sensor offline"
        failure_detail = failure_detail or "No Arduino is configured. Set ARDUINO_PORT for USB or ARDUINO_URL for Wi-Fi."
    assessment = assess(
        temperature_c=temperature_c,
        humidity_pct=humidity_pct,
        wind_speed_mph=wind_speed_mph,
        wind_speed_source=wind_speed_source,
        reading_is_fresh=reading_fresh,
        failure_kind=None if reading_fresh else failure_kind,
    )
    scored = assessment.state == "ok"

    if latitude is None or longitude is None:
        site_note = ""
    else:
        site_note = (
            "Supplemental weather uses this location. Arduino temperature and humidity "
            "are still the on-site readings. This app does not check that the sensor is actually here."
        )

    warnings = list(config_warnings)
    if supplement_error and wind_origin != "open-meteo":
        warnings.append(supplement_error)
    elif supplement_error and wind_origin == "open-meteo":
        warnings.append(f"Open-Meteo refresh failed. Using the previous wind reading. {supplement_error}")

    factors = []
    for factor in FACTORS:
        value = context.get(factor["key"]) if factor["key"] else None
        factors.append(
            {
                "label": factor["label"],
                "value": value,
                "unit": factor["unit"],
                "why": factor["why"],
                "source_hint": factor["source_hint"],
                "used_by_model": False,
            }
        )

    return {
        "disclaimer": DISCLAIMER,
        "poll_interval_seconds": poll_interval_seconds,
        "stale_after_seconds": stale_after_seconds,
        "warnings": warnings,
        "sensor": {
            "label": label,
            "temperature_c": temperature_c,
            "humidity_pct": humidity_pct,
            "unit": "C",
            "last_reading": None if last_success_at is None else last_success_at.isoformat(),
            "detail": sensor_detail(
                fresh=reading_fresh,
                failure_kind=failure_kind,
                failure_detail=failure_detail,
                has_success=has_success,
            ),
            "endpoint": endpoint,
            "connection": connection,
            "role": "environmental_input",
        },
        "wind": {
            "speed_mph": wind_speed_mph,
            "source": wind_speed_source,
            "origin": wind_origin,
            "source_label": _wind_source_label(wind_origin, wind_speed_source),
        },
        "site": {
            "latitude": latitude,
            "longitude": longitude,
            "note": site_note,
        },
        "prediction": {
            "state": assessment.state,
            "risk_score": assessment.risk_score,
            "category": assessment.category,
            "category_note": CATEGORY_NOTE,
            "confidence": None,
            "confidence_note": CONFIDENCE_NOTE,
            "official_warning": False,
            "model": MODEL_NAME,
            "reference": MODEL_REFERENCE,
            "message": prediction_message(assessment),
            "missing_inputs": list(assessment.missing_inputs),
            "model_inputs": list(MODEL_INPUTS),
            "based_on_reading_at": None if not scored or last_success_at is None else last_success_at.isoformat(),
            "derived": {
                "equilibrium_moisture_content_pct": assessment.equilibrium_moisture_content_pct,
                "moisture_damping": assessment.moisture_damping,
            },
            "inputs": [
                {
                    "name": "temperature_c",
                    "label": "Temperature",
                    "value": temperature_c,
                    "unit": "°C",
                    "source": "DHT11 via Arduino",
                    "used_by_model": scored,
                },
                {
                    "name": "relative_humidity_pct",
                    "label": "Relative humidity",
                    "value": humidity_pct,
                    "unit": "%",
                    "source": "DHT11 via Arduino",
                    "used_by_model": scored,
                },
                {
                    "name": "wind_speed_mph",
                    "label": "Wind speed",
                    "value": wind_speed_mph,
                    "unit": "mph",
                    "source": _wind_source_label(wind_origin, wind_speed_source),
                    "used_by_model": scored,
                },
            ],
        },
        "not_used_by_model": factors,
        "server_time": now.isoformat(),
    }
