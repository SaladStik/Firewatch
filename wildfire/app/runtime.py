"""In-memory sensor state, wind overrides, and history writes."""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta, timezone

from app.config import Settings
from app.model.pipeline import assess, reading_is_fresh
from app.sensor.client import FetchResult
from app.status_view import build_status
from app.store import Store
from app.supplements import SupplementResult

logger = logging.getLogger(__name__)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Runtime:
    def __init__(self, settings: Settings, store: Store):
        self.settings = settings
        self.store = store
        self._lock = threading.Lock()
        self.last_success_at: datetime | None = None
        self.temperature_c: float | None = None
        self.humidity_pct: float | None = None
        self.failure_kind: str | None = None
        self.failure_detail: str | None = None
        self.api_wind_set = False
        self.api_wind_mph: float | None = None
        self.api_wind_source: str | None = None
        self.remote_wind_mph: float | None = None
        self.remote_wind_at: datetime | None = None
        self.remote_context: dict = {}
        self.supplement_error: str | None = None
        self.supplement_attempt_at: datetime | None = None
        self._load_manual_wind()

    def _load_manual_wind(self) -> None:
        raw = self.store.get_setting("manual_wind")
        if not raw:
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return
        mph = data.get("mph")
        if data.get("set") and isinstance(mph, (int, float)) and not isinstance(mph, bool):
            self.api_wind_set = True
            self.api_wind_mph = float(mph)
            self.api_wind_source = str(data.get("source") or "dashboard")

    def _wind_unlocked(self, now: datetime) -> tuple[float | None, str | None, str | None]:
        if self.api_wind_set and self.api_wind_mph is not None:
            return self.api_wind_mph, self.api_wind_source or "dashboard", "dashboard"
        if self.settings.wind_speed_mph is not None:
            return self.settings.wind_speed_mph, self.settings.wind_speed_source or "manual", "environment"
        if self.remote_wind_mph is not None and self.remote_wind_at is not None:
            age = now - self.remote_wind_at
            if age <= timedelta(seconds=self.settings.supplement_max_age_seconds):
                return self.remote_wind_mph, "open-meteo", "open-meteo"
        return None, None, None

    def _record_args_unlocked(self, now: datetime) -> dict:
        wind, source, origin = self._wind_unlocked(now)
        return {
            "temperature_c": self.temperature_c,
            "humidity_pct": self.humidity_pct,
            "wind_speed_mph": wind,
            "wind_speed_source": source,
            "wind_origin": origin,
            "context": dict(self.remote_context),
            "observed_at": self.last_success_at,
            "failure_kind": self.failure_kind,
        }

    def _record(self, args: dict, now: datetime) -> None:
        fresh = reading_is_fresh(args["observed_at"], now, self.settings.stale_after)
        if not fresh:
            return
        assessment = assess(
            temperature_c=args["temperature_c"],
            humidity_pct=args["humidity_pct"],
            wind_speed_mph=args["wind_speed_mph"],
            wind_speed_source=args["wind_speed_source"],
            reading_is_fresh=True,
            failure_kind=None,
        )
        inputs = {
            "temperature_c": args["temperature_c"],
            "relative_humidity_pct": args["humidity_pct"],
            "wind_speed_mph": args["wind_speed_mph"],
            "wind_speed_source": args["wind_speed_source"],
            "wind_origin": args["wind_origin"],
            "equilibrium_moisture_content_pct": assessment.equilibrium_moisture_content_pct,
            "context_not_used_by_model": args["context"],
            "model_inputs": ["temperature_c", "relative_humidity_pct", "wind_speed_mph"],
        }
        self.store.insert_observation(
            recorded_at=now.isoformat(),
            temperature_c=args["temperature_c"],
            humidity_pct=args["humidity_pct"],
            wind_speed_mph=args["wind_speed_mph"],
            wind_speed_source=args["wind_speed_source"],
            inputs=inputs,
            risk_score=assessment.risk_score,
            category=assessment.category,
            prediction_status=assessment.state,
            detail=assessment.detail,
        )

    def apply_sensor_result(self, result: FetchResult, now: datetime | None = None) -> None:
        now = now or utcnow()
        with self._lock:
            previous = self.failure_kind
            if result.status == "ok":
                self.last_success_at = now
                self.temperature_c = result.temperature_c
                self.humidity_pct = result.humidity_pct
                self.failure_kind = None
                self.failure_detail = None
                if previous is not None:
                    logger.info("Sensor reading resumed")
                args = self._record_args_unlocked(now)
            else:
                self.failure_kind = result.status
                self.failure_detail = result.error
                if result.status != previous:
                    logger.warning("Sensor is not available (%s): %s", result.status, result.error)
                args = None
        if args is not None:
            self._record(args, now)

    def apply_supplement(self, result: SupplementResult, now: datetime | None = None) -> None:
        now = now or utcnow()
        with self._lock:
            if not result.ok:
                self.supplement_error = result.error
                return
            self.remote_wind_mph = result.wind_speed_mph
            self.remote_wind_at = now
            self.remote_context = {
                "wind_direction_deg": result.wind_direction_deg,
                "precipitation_mm": result.precipitation_mm,
                "surface_pressure_hpa": result.surface_pressure_hpa,
            }
            self.supplement_error = None

    def set_manual_wind(self, mph: float, source: str, now: datetime | None = None) -> None:
        now = now or utcnow()
        with self._lock:
            self.api_wind_set = True
            self.api_wind_mph = mph
            self.api_wind_source = source
            args = self._record_args_unlocked(now) if self.last_success_at is not None else None
        self.store.set_setting(
            "manual_wind",
            json.dumps({"set": True, "mph": mph, "source": source}),
        )
        if args is not None:
            self._record(args, now)

    def clear_manual_wind(self, now: datetime | None = None) -> None:
        now = now or utcnow()
        with self._lock:
            self.api_wind_set = False
            self.api_wind_mph = None
            self.api_wind_source = None
            args = self._record_args_unlocked(now) if self.last_success_at is not None else None
        self.store.delete_setting("manual_wind")
        if args is not None:
            self._record(args, now)

    def supplement_is_due(self, now: datetime) -> bool:
        if self.settings.latitude is None or self.settings.longitude is None:
            return False
        with self._lock:
            if (
                self.remote_wind_at is not None
                and self.supplement_error is None
                and now - self.remote_wind_at < timedelta(seconds=self.settings.supplement_refresh_seconds)
            ):
                return False
            if (
                self.supplement_attempt_at is not None
                and now - self.supplement_attempt_at < timedelta(seconds=60)
            ):
                return False
            self.supplement_attempt_at = now
        return True

    def status(self, now: datetime | None = None) -> dict:
        now = now or utcnow()
        with self._lock:
            wind, source, origin = self._wind_unlocked(now)
            fresh = reading_is_fresh(self.last_success_at, now, self.settings.stale_after)
            return build_status(
                now=now,
                configured=self.settings.sensor_connection is not None,
                endpoint=self.settings.sensor_location,
                poll_interval_seconds=self.settings.poll_interval_seconds,
                stale_after_seconds=self.settings.stale_after_seconds,
                connection=self.settings.sensor_connection,
                last_success_at=self.last_success_at,
                temperature_c=self.temperature_c,
                humidity_pct=self.humidity_pct,
                failure_kind=self.failure_kind,
                failure_detail=self.failure_detail,
                wind_speed_mph=wind,
                wind_speed_source=source,
                wind_origin=origin,
                context=dict(self.remote_context),
                latitude=self.settings.latitude,
                longitude=self.settings.longitude,
                supplement_error=self.supplement_error,
                config_warnings=self.settings.config_warnings,
                reading_fresh=fresh,
            )
