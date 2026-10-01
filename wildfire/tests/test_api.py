from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.main import create_app
from app.sensor.client import FetchResult
from tests.conftest import make_settings


def _client(tmp_path, **overrides):
    settings = make_settings(tmp_path, enable_poller=False, **overrides)
    app = create_app(settings)
    return TestClient(app), app


def test_dashboard_shell_separates_sensor_readings_from_the_model(tmp_path):
    client, _app = _client(tmp_path)
    with client:
        page = client.get("/")
    assert page.status_code == 200
    text = page.text
    assert "not an official wildfire warning" not in text
    assert "National Weather Service" not in text
    assert "Temperature" in text
    assert "Humidity" in text
    assert "Sensor status" in text
    assert "Last reading" in text
    assert "Wildfire risk" in text
    assert "DHT11 feed" in text
    assert "Model output" in text


def test_health_stays_up_when_the_arduino_is_not_configured(tmp_path):
    client, _app = _client(tmp_path, arduino_url="")
    with client:
        health = client.get("/api/health")
        status = client.get("/api/status")
    assert health.status_code == 200
    assert health.json()["status"] == "up"
    assert status.status_code == 200
    body = status.json()
    assert body["sensor"]["label"] == "Sensor offline"
    assert body["prediction"]["official_warning"] is False
    assert body["prediction"]["confidence"] is None
    assert body["disclaimer"]


def test_status_and_history_after_a_sensor_reading(tmp_path):
    client, _app = _client(tmp_path, wind_speed_mph=10)
    now = datetime.now(timezone.utc)
    with client:
        client.app.state.runtime.apply_sensor_result(
            FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0),
            now,
        )
        status = client.get("/api/status")
        history = client.get("/api/history")
    body = status.json()
    assert body["sensor"]["label"] == "Connected"
    assert body["sensor"]["temperature_c"] == 23.4
    assert body["prediction"]["model"].startswith("Fosberg")
    assert body["prediction"]["risk_score"] is not None
    assert body["prediction"]["confidence"] is None
    assert body["prediction"]["model_inputs"] == [
        "temperature_c",
        "relative_humidity_pct",
        "wind_speed_mph",
    ]
    points = history.json()["points"]
    assert points[-1]["temperature_c"] == 23.4
    assert points[-1]["humidity_pct"] == 42.0
    assert points[-1]["confidence"] is None
    assert points[-1]["risk_score"] is not None


def test_wind_endpoint_and_invalid_wind(tmp_path):
    client, _app = _client(tmp_path)
    now = datetime.now(timezone.utc)
    with client:
        client.app.state.runtime.apply_sensor_result(
            FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0),
            now,
        )
        missing = client.get("/api/status").json()
        assert missing["prediction"]["state"] == "missing_inputs"
        saved = client.post("/api/wind", json={"wind_speed_mph": 9.5, "source": "anemometer"})
        assert saved.status_code == 200
        assert saved.json()["prediction"]["state"] == "ok"
        assert saved.json()["prediction"]["confidence"] is None
        rejected = client.post("/api/wind", json={"wind_speed_mph": -4, "source": "nope"})
        assert rejected.status_code == 422
        still = client.get("/api/status")
        assert still.status_code == 200
        assert still.json()["prediction"]["state"] == "ok"
        cleared = client.delete("/api/wind")
        assert cleared.json()["prediction"]["state"] == "missing_inputs"
