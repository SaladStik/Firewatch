"""Turn sensor readings and supplemental wind into a model assessment."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

from app.copy import CATEGORY_NOTE, CONFIDENCE_NOTE, MODEL_NAME
from app.model.fosberg import compute_fosberg
from app.sensor.parse import HUMIDITY_MAX, HUMIDITY_MIN, TEMPERATURE_MAX_C, TEMPERATURE_MIN_C

logger = logging.getLogger(__name__)

OFFLINE_KINDS = {"offline", "timeout", "http_error", "not_configured"}


@dataclass(frozen=True)
class Assessment:
    state: str
    risk_score: float | None
    category: str | None
    confidence: None
    missing_inputs: tuple[str, ...]
    temperature_c: float | None
    humidity_pct: float | None
    wind_speed_mph: float | None
    wind_speed_source: str | None
    equilibrium_moisture_content_pct: float | None
    moisture_damping: float | None
    detail: str | None
    category_note: str = CATEGORY_NOTE
    confidence_note: str = CONFIDENCE_NOTE
    model_name: str = MODEL_NAME
    official_warning: bool = False


def reading_is_fresh(observed_at, now, stale_after) -> bool:
    if observed_at is None:
        return False
    return (now - observed_at) <= stale_after


def _withheld_state(failure_kind: str | None, has_reading: bool) -> str:
    if failure_kind == "read_failure":
        return "read_failure"
    if failure_kind in {"malformed", "invalid"}:
        return "invalid_sensor"
    if failure_kind is None and has_reading:
        return "stale_sensor"
    return "sensor_offline"


def _empty(
    state: str,
    temperature_c: float | None,
    humidity_pct: float | None,
    wind_speed_mph: float | None,
    wind_speed_source: str | None,
    missing: tuple[str, ...] = (),
    detail: str | None = None,
) -> Assessment:
    return Assessment(
        state=state,
        risk_score=None,
        category=None,
        confidence=None,
        missing_inputs=missing,
        temperature_c=temperature_c,
        humidity_pct=humidity_pct,
        wind_speed_mph=wind_speed_mph,
        wind_speed_source=wind_speed_source,
        equilibrium_moisture_content_pct=None,
        moisture_damping=None,
        detail=detail,
    )


def _inputs_are_physical(temperature_c: float, humidity_pct: float) -> bool:
    return (
        math.isfinite(temperature_c)
        and math.isfinite(humidity_pct)
        and TEMPERATURE_MIN_C <= temperature_c <= TEMPERATURE_MAX_C
        and HUMIDITY_MIN <= humidity_pct <= HUMIDITY_MAX
    )


def assess(
    *,
    temperature_c: float | None,
    humidity_pct: float | None,
    wind_speed_mph: float | None,
    wind_speed_source: str | None,
    reading_is_fresh: bool,
    failure_kind: str | None,
    compute=compute_fosberg,
) -> Assessment:
    has_reading = temperature_c is not None and humidity_pct is not None
    if not reading_is_fresh or not has_reading:
        return _empty(
            _withheld_state(failure_kind, has_reading),
            temperature_c,
            humidity_pct,
            wind_speed_mph,
            wind_speed_source,
        )

    if not _inputs_are_physical(temperature_c, humidity_pct):
        return _empty(
            "invalid_sensor",
            temperature_c,
            humidity_pct,
            wind_speed_mph,
            wind_speed_source,
            detail="Temperature or humidity is outside the accepted range",
        )

    if wind_speed_mph is None:
        return _empty(
            "missing_inputs",
            temperature_c,
            humidity_pct,
            None,
            None,
            missing=("wind_speed_mph",),
            detail="Wind speed is required and was not provided",
        )

    if not math.isfinite(wind_speed_mph) or wind_speed_mph < 0 or wind_speed_mph > 200:
        return _empty(
            "model_error",
            temperature_c,
            humidity_pct,
            wind_speed_mph,
            wind_speed_source,
            detail="Wind speed is outside 0 to 200 mph",
        )

    try:
        result = compute(temperature_c, humidity_pct, wind_speed_mph)
    except Exception:
        logger.exception("Fosberg calculation failed")
        return _empty(
            "model_error",
            temperature_c,
            humidity_pct,
            wind_speed_mph,
            wind_speed_source,
            detail="The Fosberg calculation failed",
        )

    return Assessment(
        state="ok",
        risk_score=round(result.risk_score, 2),
        category=result.category,
        confidence=None,
        missing_inputs=(),
        temperature_c=temperature_c,
        humidity_pct=humidity_pct,
        wind_speed_mph=wind_speed_mph,
        wind_speed_source=wind_speed_source,
        equilibrium_moisture_content_pct=result.equilibrium_moisture_content_pct,
        moisture_damping=result.moisture_damping,
        detail=None,
    )
