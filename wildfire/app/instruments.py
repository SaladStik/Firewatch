"""Catalog of field instruments. Each entry is one data collector."""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import PROJECT_ROOT
from app.model.pipeline import assess
from app.runtime import Runtime
from app.status_view import build_status

logger = logging.getLogger(__name__)

CATALOG_PATH = PROJECT_ROOT / "instruments.json"
REMOTE_TIMEOUT_SECONDS = 2.5
CACHE_SECONDS = 8.0

_remote_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_demo_state: dict[str, dict[str, float]] = {}
_demo_history: dict[str, list[dict[str, Any]]] = {}


def _default_catalog() -> list[dict[str, Any]]:
    return [
        {
            "id": "local-dht11",
            "name": "Local DHT11",
            "location": "Local station",
            "latitude": None,
            "longitude": None,
            "kind": "local",
            "dashboard": "http://127.0.0.1:8000/",
        }
    ]


def _optional_coord(value: Any, low: float, high: float) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < low or number > high:
        return None
    return number


def _clean_entry(raw: Any, seen: set[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    instrument_id = str(raw.get("id") or "").strip()
    name = str(raw.get("name") or "").strip()
    location = str(raw.get("location") or "").strip()
    if not instrument_id or not name or not location or instrument_id in seen:
        return None
    kind = str(raw.get("kind") or "").strip().lower()
    if kind not in {"local", "status", "demo"}:
        return None
    url = str(raw.get("url") or "").strip().rstrip("/")
    if kind == "status" and not url.startswith(("http://", "https://")):
        return None
    dashboard = str(raw.get("dashboard") or "").strip()
    if dashboard and not dashboard.startswith(("http://", "https://")):
        dashboard = ""
    if kind == "local" and not dashboard:
        dashboard = "http://127.0.0.1:8000/"
    if kind == "demo" and not dashboard:
        dashboard = f"http://127.0.0.1:8000/?instrument={instrument_id}"
    seen.add(instrument_id)
    return {
        "id": instrument_id,
        "name": name,
        "location": location,
        "latitude": _optional_coord(raw.get("latitude"), -90, 90),
        "longitude": _optional_coord(raw.get("longitude"), -180, 180),
        "kind": kind,
        "url": url if kind == "status" else None,
        "dashboard": dashboard or None,
    }


def load_catalog() -> list[dict[str, Any]]:
    if not CATALOG_PATH.is_file():
        return _default_catalog()
    try:
        payload = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.exception("Could not read %s", CATALOG_PATH)
        return _default_catalog()
    rows = payload.get("instruments") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return _default_catalog()
    seen: set[str] = set()
    catalog = [entry for row in rows if (entry := _clean_entry(row, seen))]
    return catalog or _default_catalog()


def summarize_status(status: dict[str, Any]) -> dict[str, Any]:
    sensor = status.get("sensor") if isinstance(status.get("sensor"), dict) else {}
    wind = status.get("wind") if isinstance(status.get("wind"), dict) else {}
    prediction = status.get("prediction") if isinstance(status.get("prediction"), dict) else {}
    site = status.get("site") if isinstance(status.get("site"), dict) else {}
    return {
        "ok": sensor.get("label") == "Connected",
        "label": sensor.get("label") or "Sensor offline",
        "temperature_c": sensor.get("temperature_c"),
        "humidity_pct": sensor.get("humidity_pct"),
        "wind_mph": wind.get("speed_mph"),
        "risk_score": prediction.get("risk_score"),
        "category": prediction.get("category"),
        "detail": sensor.get("detail"),
        "endpoint": sensor.get("endpoint"),
        "latitude": site.get("latitude"),
        "longitude": site.get("longitude"),
    }


def _unreachable(detail: str) -> dict[str, Any]:
    return {
        "ok": False,
        "label": "Unreachable",
        "temperature_c": None,
        "humidity_pct": None,
        "wind_mph": None,
        "risk_score": None,
        "category": None,
        "detail": detail,
        "endpoint": None,
        "latitude": None,
        "longitude": None,
    }


def _with_reading(entry: dict[str, Any], reading: dict[str, Any]) -> dict[str, Any]:
    latitude = entry["latitude"] if entry["latitude"] is not None else reading.get("latitude")
    longitude = entry["longitude"] if entry["longitude"] is not None else reading.get("longitude")
    return {
        "id": entry["id"],
        "name": entry["name"],
        "location": entry["location"],
        "latitude": latitude,
        "longitude": longitude,
        "kind": entry["kind"],
        "dashboard": entry["dashboard"],
        "reading": {key: value for key, value in reading.items() if key not in {"latitude", "longitude"}},
    }


async def _remote_reading(entry: dict[str, Any], client: httpx.AsyncClient) -> dict[str, Any]:
    cached = _remote_cache.get(entry["id"])
    now = time.monotonic()
    if cached and now - cached[0] < CACHE_SECONDS:
        return cached[1]
    url = f"{entry['url']}/api/status"
    try:
        response = await client.get(url)
        payload = response.json()
        if response.status_code != 200 or not isinstance(payload, dict):
            reading = _unreachable(f"Collector returned HTTP {response.status_code}")
        else:
            reading = summarize_status(payload)
            reading["endpoint"] = entry["url"]
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        reading = _unreachable("Could not reach this data collector")
    _remote_cache[entry["id"]] = (now, reading)
    return reading


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _drift(value: float, center: float, rate: float, low: float, high: float, elapsed: float, rng: random.Random) -> float:
    elapsed = min(max(elapsed, 0.0), 30.0)
    if elapsed == 0:
        return value
    direction = rng.choice((-1.0, 1.0))
    delta = direction * rng.uniform(0.35, 1.0) * rate * elapsed
    pull = (center - value) * 0.04 * elapsed
    return _clamp(value + delta + pull, low, high)


def _assess_demo(state: dict[str, float]):
    return assess(
        temperature_c=state["temperature_c"],
        humidity_pct=state["humidity_pct"],
        wind_speed_mph=state["wind_mph"],
        wind_speed_source="demo",
        reading_is_fresh=True,
        failure_kind=None,
    )


def _history_point(state: dict[str, float], when: datetime) -> dict[str, Any]:
    assessment = _assess_demo(state)
    return {
        "recorded_at": when.isoformat(),
        "temperature_c": round(state["temperature_c"], 1),
        "humidity_pct": round(state["humidity_pct"]),
        "wind_speed_mph": round(state["wind_mph"], 1),
        "wind_speed_source": "demo",
        "inputs": {},
        "risk_score": assessment.risk_score,
        "category": assessment.category,
        "confidence": None,
        "prediction_status": assessment.state,
        "detail": None,
    }


def _climate(entry: dict[str, Any]) -> dict[str, float]:
    """Each station keeps its own weather, so the list does not collapse to one climate."""
    seed = random.Random(str(entry.get("id") or "station"))
    latitude = entry.get("latitude")
    lat_nudge = 0.0
    if isinstance(latitude, (int, float)):
        lat_nudge = (54.0 - float(latitude)) * 0.9
    return {
        "temp_center": _clamp(seed.uniform(0.0, 34.0) + lat_nudge, -12.0, 37.0),
        "humidity_center": seed.uniform(12.0, 94.0),
        "wind_center": seed.uniform(0.5, 34.0),
    }


def _step_demo(state: dict[str, float], elapsed: float, rng: random.Random) -> dict[str, float]:
    temperature = state["temperature_c"]
    humidity = state["humidity_pct"]
    wind = state["wind_mph"]
    temp_center = state.get("temp_center", 16.5)
    humidity_center = state.get("humidity_center", 48.0)
    wind_center = state.get("wind_center", 8.0)
    if not state.get("temp_hold"):
        temperature = _drift(temperature, temp_center, 0.08, -12.0, 38.0, elapsed, rng)
    if not state.get("humidity_hold"):
        humidity = _drift(humidity, humidity_center, 0.35, 8.0, 98.0, elapsed, rng)
    if not state.get("wind_hold"):
        wind = _drift(wind, wind_center, 0.15, 0.0, 42.0, elapsed, rng)
    return {
        "temperature_c": temperature,
        "humidity_pct": humidity,
        "wind_mph": wind,
        "temp_center": temp_center,
        "humidity_center": humidity_center,
        "wind_center": wind_center,
        "wind_hold": state.get("wind_hold", 0.0),
        "temp_hold": state.get("temp_hold", 0.0),
        "humidity_hold": state.get("humidity_hold", 0.0),
        "at": state["at"],
    }


def demo_reading(entry: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """Smooth random walk so a demo station changes a little on each refresh."""
    moment = time.monotonic() if now is None else now
    station_id = entry["id"]
    state = _demo_state.get(station_id)
    rng = random.Random()
    history = _demo_history.setdefault(station_id, [])
    if state is None:
        climate = _climate(entry)
        state = {
            "temperature_c": climate["temp_center"],
            "humidity_pct": climate["humidity_center"],
            "wind_mph": climate["wind_center"],
            "temp_center": climate["temp_center"],
            "humidity_center": climate["humidity_center"],
            "wind_center": climate["wind_center"],
            "wind_hold": 0.0,
            "temp_hold": 0.0,
            "humidity_hold": 0.0,
            "at": moment,
        }
        when = datetime.now(timezone.utc) - timedelta(seconds=8 * 36)
        for _ in range(36):
            state = _step_demo(state, 8.0, rng)
            when += timedelta(seconds=8)
            history.append(_history_point(state, when))
        state["at"] = moment
    else:
        elapsed = moment - state["at"]
        if elapsed > 0:
            state = _step_demo(state, elapsed, rng)
            state["at"] = moment
            history.append(_history_point(state, datetime.now(timezone.utc)))
            del history[:-500]
    _demo_state[station_id] = state
    assessment = _assess_demo(state)
    return {
        "ok": True,
        "label": "Connected",
        "temperature_c": round(state["temperature_c"], 1),
        "humidity_pct": round(state["humidity_pct"]),
        "wind_mph": round(state["wind_mph"], 1),
        "risk_score": assessment.risk_score,
        "category": assessment.category,
        "detail": None,
        "endpoint": "Demo feed",
    }


def demo_status(entry: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    reading = demo_reading(entry, now)
    moment = datetime.now(timezone.utc)
    return build_status(
        now=moment,
        configured=True,
        endpoint="Demo feed",
        poll_interval_seconds=8,
        stale_after_seconds=30,
        connection="demo",
        last_success_at=moment,
        temperature_c=reading["temperature_c"],
        humidity_pct=reading["humidity_pct"],
        failure_kind=None,
        failure_detail=None,
        wind_speed_mph=reading["wind_mph"],
        wind_speed_source="demo",
        wind_origin="demo",
        context={},
        latitude=entry.get("latitude"),
        longitude=entry.get("longitude"),
        supplement_error=None,
        config_warnings=(),
        reading_fresh=True,
    )


def demo_history(station_id: str, limit: int) -> list[dict[str, Any]]:
    points = _demo_history.get(station_id, [])
    return points[-limit:]


def _append_demo_history(station_id: str, state: dict[str, float]) -> None:
    history = _demo_history.setdefault(station_id, [])
    history.append(_history_point(state, datetime.now(timezone.utc)))
    del history[:-500]


def adjust_demo(entry: dict[str, Any], temperature_delta: float = 0.0, humidity_delta: float = 0.0) -> None:
    """Hold a demo station on test values so the drift no longer moves that reading."""
    demo_reading(entry)
    state = _demo_state[entry["id"]]
    if temperature_delta:
        state["temperature_c"] = _clamp(state["temperature_c"] + temperature_delta, 5.0, 32.0)
        state["temp_hold"] = 1.0
    if humidity_delta:
        state["humidity_pct"] = _clamp(state["humidity_pct"] + humidity_delta, 18.0, 80.0)
        state["humidity_hold"] = 1.0
    _demo_state[entry["id"]] = state
    _append_demo_history(entry["id"], state)


def hold_demo_wind(entry: dict[str, Any], wind_mph: float) -> None:
    demo_reading(entry)
    state = _demo_state[entry["id"]]
    state["wind_mph"] = wind_mph
    state["wind_hold"] = 1.0
    _demo_state[entry["id"]] = state


def catalog_entry(station_id: str | None) -> dict[str, Any] | None:
    if not station_id:
        return None
    for entry in load_catalog():
        if entry["id"] == station_id:
            return entry
    return None


async def list_instruments(runtime: Runtime) -> list[dict[str, Any]]:
    catalog = load_catalog()
    local_reading = summarize_status(runtime.status())
    remotes = [entry for entry in catalog if entry["kind"] == "status"]
    remote_readings: dict[str, dict[str, Any]] = {}
    if remotes:
        timeout = httpx.Timeout(REMOTE_TIMEOUT_SECONDS)
        async with httpx.AsyncClient(timeout=timeout) as client:
            pulled = await asyncio.gather(*(_remote_reading(entry, client) for entry in remotes))
            remote_readings = {entry["id"]: reading for entry, reading in zip(remotes, pulled)}
    instruments = []
    for entry in catalog:
        if entry["kind"] == "local":
            instruments.append(_with_reading(entry, local_reading))
        elif entry["kind"] == "demo":
            instruments.append(_with_reading(entry, demo_reading(entry)))
        else:
            instruments.append(_with_reading(entry, remote_readings[entry["id"]]))
    return instruments
