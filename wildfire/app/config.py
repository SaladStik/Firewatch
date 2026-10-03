"""Environment configuration. Secrets and the Arduino address stay out of code."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path) -> None:
    """Load a .env file without overriding variables already set in the process."""
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip('"').strip("'")


def join_sensor_url(base: str, path: str) -> str | None:
    cleaned = (base or "").strip().rstrip("/")
    if not cleaned:
        return None
    if not cleaned.startswith(("http://", "https://")):
        cleaned = "http://" + cleaned
    sensor_path = path if path.startswith("/") else f"/{path}"
    if cleaned.endswith(sensor_path):
        return cleaned
    return cleaned + sensor_path


def _blank(value: str | None) -> str:
    return (value or "").strip()


def _optional_float(raw: str, name: str, warnings: list[str], minimum: float, maximum: float) -> float | None:
    text = raw.strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        warnings.append(f"{name} is invalid and was ignored")
        return None
    if not math.isfinite(value) or value < minimum or value > maximum:
        warnings.append(f"{name} is out of range and was ignored")
        return None
    return value


@dataclass(frozen=True)
class Settings:
    arduino_url: str
    arduino_sensor_path: str
    arduino_port: str
    arduino_baud: int
    poll_interval_seconds: float
    http_timeout_seconds: float
    stale_after_seconds: float
    wind_speed_mph: float | None
    wind_speed_source: str
    latitude: float | None
    longitude: float | None
    sqlite_path: Path
    enable_poller: bool
    supplement_refresh_seconds: float
    supplement_max_age_seconds: float
    config_warnings: tuple[str, ...]
    host: str
    port: int

    @property
    def sensor_endpoint(self) -> str | None:
        if self.arduino_port:
            return None
        return join_sensor_url(self.arduino_url, self.arduino_sensor_path)

    @property
    def sensor_connection(self) -> str | None:
        if self.arduino_port:
            return "usb"
        if self.sensor_endpoint:
            return "http"
        return None

    @property
    def sensor_location(self) -> str | None:
        if self.arduino_port:
            return f"{self.arduino_port} at {self.arduino_baud} baud"
        return self.sensor_endpoint

    @property
    def stale_after(self) -> timedelta:
        return timedelta(seconds=self.stale_after_seconds)

    @classmethod
    def load(cls, dotenv_path: Path | None = None) -> Settings:
        load_dotenv(PROJECT_ROOT / ".env" if dotenv_path is None else dotenv_path)
        warnings: list[str] = []

        try:
            interval = float(os.environ.get("SENSOR_POLL_INTERVAL_SECONDS", "8") or "8")
        except ValueError:
            warnings.append("SENSOR_POLL_INTERVAL_SECONDS is invalid; using 8")
            interval = 8.0
        if interval < 5 or interval > 10:
            warnings.append(
                "SENSOR_POLL_INTERVAL_SECONDS was clamped to 5-10 seconds so the station is not polled too often"
            )
            interval = min(10.0, max(5.0, interval))

        try:
            timeout = float(os.environ.get("SENSOR_HTTP_TIMEOUT_SECONDS", "3") or "3")
        except ValueError:
            warnings.append("SENSOR_HTTP_TIMEOUT_SECONDS is invalid; using 3")
            timeout = 3.0
        timeout = min(15.0, max(1.0, timeout))

        try:
            stale = float(os.environ.get("SENSOR_STALE_AFTER_SECONDS", "30") or "30")
        except ValueError:
            warnings.append("SENSOR_STALE_AFTER_SECONDS is invalid; using 30")
            stale = 30.0
        minimum_stale = interval * 2
        if stale < minimum_stale:
            warnings.append(
                "SENSOR_STALE_AFTER_SECONDS was raised so one missed poll does not mark the sensor stale"
            )
            stale = minimum_stale

        wind = _optional_float(
            os.environ.get("WIND_SPEED_MPH", ""),
            "WIND_SPEED_MPH",
            warnings,
            0.0,
            200.0,
        )
        latitude = _optional_float(os.environ.get("LATITUDE", ""), "LATITUDE", warnings, -90.0, 90.0)
        longitude = _optional_float(os.environ.get("LONGITUDE", ""), "LONGITUDE", warnings, -180.0, 180.0)
        if (latitude is None) ^ (longitude is None):
            warnings.append("Set both LATITUDE and LONGITUDE, or leave both blank")
            latitude = None
            longitude = None

        sqlite_raw = _blank(os.environ.get("SQLITE_PATH", "data/wildfire.sqlite")) or "data/wildfire.sqlite"
        sqlite_path = Path(sqlite_raw)
        if not sqlite_path.is_absolute():
            sqlite_path = PROJECT_ROOT / sqlite_path

        flag = os.environ.get("ENABLE_POLLER", "1").strip().lower()
        enable_poller = flag not in {"0", "false", "no", "off"}

        try:
            port = int(os.environ.get("PORT", "8000") or "8000")
        except ValueError:
            warnings.append("PORT is invalid; using 8000")
            port = 8000
        if not 1 <= port <= 65535:
            warnings.append("PORT is out of range; using 8000")
            port = 8000

        source = _blank(os.environ.get("WIND_SPEED_SOURCE", "manual")) or "manual"
        host = _blank(os.environ.get("HOST", "0.0.0.0")) or "0.0.0.0"
        sensor_path = _blank(os.environ.get("ARDUINO_SENSOR_PATH", "/api/sensor")) or "/api/sensor"
        arduino_port = _blank(os.environ.get("ARDUINO_PORT", ""))
        if arduino_port.lower() == "auto":
            arduino_port = ""
        if not arduino_port:
            from app.sensor.ports import detect_arduino_port

            detected = detect_arduino_port()
            if detected:
                arduino_port = detected
        try:
            baud = int(os.environ.get("ARDUINO_BAUD", "9600") or "9600")
        except ValueError:
            warnings.append("ARDUINO_BAUD is invalid; using 9600")
            baud = 9600
        if baud <= 0:
            warnings.append("ARDUINO_BAUD is invalid; using 9600")
            baud = 9600

        return cls(
            arduino_url=_blank(os.environ.get("ARDUINO_URL", "")),
            arduino_sensor_path=sensor_path,
            arduino_port=arduino_port,
            arduino_baud=baud,
            poll_interval_seconds=interval,
            http_timeout_seconds=timeout,
            stale_after_seconds=stale,
            wind_speed_mph=wind,
            wind_speed_source=source[:80],
            latitude=latitude,
            longitude=longitude,
            sqlite_path=sqlite_path,
            enable_poller=enable_poller,
            supplement_refresh_seconds=600.0,
            supplement_max_age_seconds=1800.0,
            config_warnings=tuple(warnings),
            host=host,
            port=port,
        )
