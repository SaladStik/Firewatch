import asyncio

import httpx

from app.mock_arduino import MockArduino, sensor_body
from app.poller import poll_once
from app.runtime import Runtime
from app.sensor.parse import parse_sensor_payload
from app.store import Store
from tests.conftest import make_settings


def test_mock_sensor_endpoint_is_parseable():
    _status, body, content_type = sensor_body("ok")
    assert content_type == "application/json"
    import json

    reading = parse_sensor_payload(json.loads(body))
    assert 5 <= reading.temperature_c <= 35
    assert 20 <= reading.humidity_pct <= 90


def test_mock_failure_modes():
    import json

    status, body, _content_type = sensor_body("dht_failure")
    assert status == 503
    assert json.loads(body)["error"] == "dht_read_failure"
    status, body, _content_type = sensor_body("malformed")
    assert body == b"temperature=hot"
    status, body, _content_type = sensor_body("invalid")
    assert json.loads(body)["humidity"] == 250


def test_poll_against_mock_arduino(tmp_path):
    server = MockArduino(scenario="ok").start()
    settings = make_settings(
        tmp_path,
        arduino_url=server.base_url,
        wind_speed_mph=10,
        http_timeout_seconds=2,
    )
    store = Store(settings.sqlite_path)
    runtime = Runtime(settings, store)

    async def once():
        async with httpx.AsyncClient(timeout=2) as client:
            await poll_once(runtime, client)

    try:
        asyncio.run(once())
        view = runtime.status()
        assert view["sensor"]["label"] == "Connected"
        assert view["sensor"]["temperature_c"] is not None
        assert view["prediction"]["state"] == "ok"
        assert view["prediction"]["confidence"] is None
        assert view["prediction"]["official_warning"] is False
        assert runtime.store.recent(1)[0]["humidity_pct"] is not None
    finally:
        store.close()
        server.close()


def test_poll_reports_mock_dht_failure(tmp_path):
    server = MockArduino(scenario="dht_failure").start()
    settings = make_settings(tmp_path, arduino_url=server.base_url, http_timeout_seconds=2)
    store = Store(settings.sqlite_path)
    runtime = Runtime(settings, store)

    async def once():
        async with httpx.AsyncClient(timeout=2) as client:
            await poll_once(runtime, client)

    try:
        asyncio.run(once())
        view = runtime.status()
        assert view["sensor"]["label"] == "Sensor read failed"
        assert view["prediction"]["risk_score"] is None
        assert view["prediction"]["state"] == "read_failure"
    finally:
        store.close()
        server.close()


def test_poll_reports_malformed_mock(tmp_path):
    server = MockArduino(scenario="malformed").start()
    settings = make_settings(tmp_path, arduino_url=server.base_url, http_timeout_seconds=2)
    store = Store(settings.sqlite_path)
    runtime = Runtime(settings, store)

    async def once():
        async with httpx.AsyncClient(timeout=2) as client:
            await poll_once(runtime, client)

    try:
        asyncio.run(once())
        view = runtime.status()
        assert view["sensor"]["label"] == "Invalid sensor data"
        assert view["prediction"]["state"] == "invalid_sensor"
    finally:
        store.close()
        server.close()


def test_closed_port_stays_offline(tmp_path):
    settings = make_settings(
        tmp_path,
        arduino_url="http://127.0.0.1:1",
        http_timeout_seconds=1,
        wind_speed_mph=10,
    )
    store = Store(settings.sqlite_path)
    runtime = Runtime(settings, store)

    async def once():
        timeout = httpx.Timeout(1.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            await poll_once(runtime, client)

    try:
        asyncio.run(once())
        view = runtime.status()
        assert view["sensor"]["label"] == "Sensor offline"
        assert view["prediction"]["risk_score"] is None
        again = runtime.status()
        assert again["sensor"]["label"] == "Sensor offline"
    finally:
        store.close()
