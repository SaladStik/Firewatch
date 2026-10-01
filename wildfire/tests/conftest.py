from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.config import Settings
from app.runtime import Runtime
from app.store import Store


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = dict(
        arduino_url="",
        arduino_sensor_path="/api/sensor",
        arduino_port="",
        arduino_baud=9600,
        poll_interval_seconds=8,
        http_timeout_seconds=3,
        stale_after_seconds=30,
        wind_speed_mph=None,
        wind_speed_source="manual",
        latitude=None,
        longitude=None,
        sqlite_path=tmp_path / "test.sqlite",
        enable_poller=False,
        supplement_refresh_seconds=600,
        supplement_max_age_seconds=1800,
        config_warnings=(),
        host="127.0.0.1",
        port=8000,
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def runtime(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings.sqlite_path)
    holder = Runtime(settings, store)
    yield holder
    store.close()


def utc(**kwargs) -> datetime:
    base = datetime(2026, 9, 30, 19, 42, 17, tzinfo=timezone.utc)
    return base + timedelta(**kwargs)
