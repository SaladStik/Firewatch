"""Optional wind and weather context. These do not replace the station reading."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


def open_meteo_params(latitude: float, longitude: float) -> dict[str, str | float]:
    return {
        "latitude": latitude,
        "longitude": longitude,
        "current": "wind_speed_10m,wind_direction_10m,precipitation,surface_pressure",
        "wind_speed_unit": "mph",
        "timezone": "UTC",
    }


@dataclass(frozen=True)
class SupplementResult:
    ok: bool
    wind_speed_mph: float | None = None
    wind_direction_deg: float | None = None
    precipitation_mm: float | None = None
    surface_pressure_hpa: float | None = None
    error: str | None = None
    source: str = "open-meteo"


def _optional_number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in {float("inf"), float("-inf")}:
        return None
    return number


def parse_open_meteo(payload: object) -> SupplementResult:
    if not isinstance(payload, dict):
        return SupplementResult(ok=False, error="Open-Meteo response was not an object")
    current = payload.get("current")
    if not isinstance(current, dict):
        return SupplementResult(ok=False, error="Open-Meteo response had no current weather")
    wind = _optional_number(current.get("wind_speed_10m"))
    if wind is None or wind < 0 or wind > 200:
        return SupplementResult(ok=False, error="Open-Meteo did not include a usable wind speed")
    return SupplementResult(
        ok=True,
        wind_speed_mph=wind,
        wind_direction_deg=_optional_number(current.get("wind_direction_10m")),
        precipitation_mm=_optional_number(current.get("precipitation")),
        surface_pressure_hpa=_optional_number(current.get("surface_pressure")),
    )


async def fetch_open_meteo(
    client: httpx.AsyncClient,
    latitude: float,
    longitude: float,
) -> SupplementResult:
    try:
        response = await client.get(
            OPEN_METEO_URL,
            params=open_meteo_params(latitude, longitude),
            timeout=8.0,
        )
    except httpx.TimeoutException:
        return SupplementResult(ok=False, error="Open-Meteo request timed out")
    except httpx.HTTPError:
        return SupplementResult(ok=False, error="Open-Meteo was unreachable")
    if response.status_code != 200:
        return SupplementResult(ok=False, error=f"Open-Meteo returned HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        return SupplementResult(ok=False, error="Open-Meteo response was not JSON")
    return parse_open_meteo(payload)
