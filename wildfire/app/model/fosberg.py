"""Fosberg Fire Weather Index.

The index estimates how temperature, relative humidity, and wind speed would
affect fine-fuel moisture and flame length. It is not a fire-occurrence model
and it is not an official warning.

Equilibrium moisture uses temperature in Fahrenheit and relative humidity in
percent. Relative humidity below 10% uses the dry branch, 10% through 50% uses
the middle branch, and above 50% uses the wet branch. Exactly 10% uses the
middle branch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.copy import DISPLAY_BANDS


@dataclass(frozen=True)
class FosbergResult:
    risk_score: float
    equilibrium_moisture_content_pct: float
    moisture_damping: float
    category: str
    capped: bool


def celsius_to_fahrenheit(temperature_c: float) -> float:
    return temperature_c * 9.0 / 5.0 + 32.0


def equilibrium_moisture_content(temperature_f: float, relative_humidity: float) -> float:
    humidity = relative_humidity
    if humidity < 10:
        return 0.03229 + 0.281073 * humidity - 0.000578 * humidity * temperature_f
    if humidity <= 50:
        return 2.22749 + 0.160107 * humidity - 0.01478 * temperature_f
    return (
        21.0606
        + 0.005565 * humidity * humidity
        - 0.00035 * humidity * temperature_f
        - 0.483199 * humidity
    )


def display_band(score: float) -> str:
    for limit, name in DISPLAY_BANDS:
        if score < limit:
            return name
    return "Extreme"


def compute_fosberg(
    temperature_c: float,
    relative_humidity: float,
    wind_speed_mph: float,
) -> FosbergResult:
    moisture = equilibrium_moisture_content(celsius_to_fahrenheit(temperature_c), relative_humidity)
    ratio = moisture / 30.0
    damping = 1.0 - 2.0 * ratio + 1.5 * ratio**2 - 0.5 * ratio**3
    raw = damping * math.sqrt(1.0 + wind_speed_mph**2) / 0.3002
    if not math.isfinite(raw):
        raise ValueError("Fosberg index was not a finite number")
    capped = raw > 100.0
    score = min(100.0, max(0.0, raw))
    return FosbergResult(
        risk_score=score,
        equilibrium_moisture_content_pct=moisture,
        moisture_damping=damping,
        category=display_band(score),
        capped=capped,
    )
