"""HTTP API for the dashboard."""

from __future__ import annotations

import logging
import math

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from app.copy import DISCLAIMER
from app.instruments import adjust_demo, catalog_entry, demo_history, demo_status, hold_demo_wind, list_instruments

logger = logging.getLogger(__name__)
router = APIRouter()
NO_STORE = {"Cache-Control": "no-store"}


class DemoAdjust(BaseModel):
    instrument: str
    temperature_delta: float = 0
    humidity_delta: float = 0

    @field_validator("temperature_delta", "humidity_delta")
    @classmethod
    def finite_delta(cls, value: float) -> float:
        if not math.isfinite(value) or abs(value) > 20:
            raise ValueError("delta must be a finite number within 20")
        return value

    @field_validator("instrument")
    @classmethod
    def instrument_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned or len(cleaned) > 80:
            raise ValueError("instrument must be 1-80 characters")
        return cleaned


class WindUpdate(BaseModel):
    wind_speed_mph: float = Field(..., ge=0, le=200)
    source: str = "dashboard"
    instrument: str | None = None

    @field_validator("wind_speed_mph")
    @classmethod
    def finite_wind(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("wind_speed_mph must be a finite number")
        return value

    @field_validator("source")
    @classmethod
    def source_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned or len(cleaned) > 80:
            raise ValueError("source must be 1-80 characters")
        return cleaned


def _fallback_status() -> dict:
    return {
        "disclaimer": DISCLAIMER,
        "warnings": ["The status service hit an unexpected error."],
        "sensor": {
            "label": "Sensor offline",
            "temperature_c": None,
            "humidity_pct": None,
            "unit": "C",
            "last_reading": None,
            "detail": "The status service hit an unexpected error.",
            "endpoint": None,
            "role": "environmental_input",
        },
        "prediction": {
            "state": "model_error",
            "risk_score": None,
            "category": None,
            "confidence": None,
            "official_warning": False,
            "message": "The model estimate is unavailable because of an internal error.",
            "missing_inputs": [],
            "model_inputs": ["temperature_c", "relative_humidity_pct", "wind_speed_mph"],
            "inputs": [],
        },
        "not_used_by_model": [],
    }


@router.get("/api/health")
def health(request: Request) -> JSONResponse:
    runtime = request.app.state.runtime
    try:
        label = runtime.status()["sensor"]["label"]
    except Exception:
        logger.exception("health status failed")
        label = "Sensor offline"
    return JSONResponse({"status": "up", "sensor_label": label}, headers=NO_STORE)


@router.get("/api/instruments")
async def instruments(request: Request) -> JSONResponse:
    try:
        rows = await list_instruments(request.app.state.runtime)
    except Exception:
        logger.exception("instrument list failed")
        rows = []
    return JSONResponse({"instruments": rows}, headers=NO_STORE)


def _demo_entry(instrument: str | None):
    entry = catalog_entry(instrument)
    if entry and entry["kind"] == "demo":
        return entry
    return None


@router.get("/api/status")
def status(request: Request, instrument: str | None = None) -> JSONResponse:
    demo = _demo_entry(instrument)
    if demo is not None:
        return JSONResponse(demo_status(demo), headers=NO_STORE)
    try:
        payload = request.app.state.runtime.status()
    except Exception:
        logger.exception("status failed")
        payload = _fallback_status()
    return JSONResponse(payload, headers=NO_STORE)


@router.get("/api/history")
def history(request: Request, limit: int = 500, instrument: str | None = None) -> JSONResponse:
    bounded = max(1, min(limit, 2000))
    demo = _demo_entry(instrument)
    if demo is not None:
        return JSONResponse({"points": demo_history(demo["id"], bounded)}, headers=NO_STORE)
    try:
        points = request.app.state.store.recent(bounded)
    except Exception:
        logger.exception("history failed")
        points = []
    points.reverse()
    return JSONResponse({"points": points}, headers=NO_STORE)


@router.post("/api/demo")
def adjust_demo_station(body: DemoAdjust) -> JSONResponse:
    demo = _demo_entry(body.instrument)
    if demo is None:
        return JSONResponse({"detail": "That station is not a demo feed."}, status_code=404, headers=NO_STORE)
    adjust_demo(demo, body.temperature_delta, body.humidity_delta)
    return JSONResponse(demo_status(demo), headers=NO_STORE)


@router.post("/api/wind")
def update_wind(body: WindUpdate, request: Request) -> JSONResponse:
    demo = _demo_entry(body.instrument)
    if demo is not None:
        hold_demo_wind(demo, body.wind_speed_mph)
        return JSONResponse(demo_status(demo), headers=NO_STORE)
    request.app.state.runtime.set_manual_wind(body.wind_speed_mph, body.source)
    return JSONResponse(request.app.state.runtime.status(), headers=NO_STORE)


@router.delete("/api/wind")
def clear_wind(request: Request) -> JSONResponse:
    request.app.state.runtime.clear_manual_wind()
    return JSONResponse(request.app.state.runtime.status(), headers=NO_STORE)
