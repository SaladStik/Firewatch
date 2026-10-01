from app.config import Settings, join_sensor_url


def test_sensor_url_uses_the_configured_base_once():
    assert join_sensor_url("http://sensor.local", "/api/sensor") == "http://sensor.local/api/sensor"
    assert join_sensor_url("http://sensor.local/api/sensor", "/api/sensor") == "http://sensor.local/api/sensor"
    assert join_sensor_url("sensor.local", "/api/sensor") == "http://sensor.local/api/sensor"
    assert join_sensor_url("", "/api/sensor") is None


def test_poll_interval_is_clamped(tmp_path, monkeypatch):
    monkeypatch.setenv("SENSOR_POLL_INTERVAL_SECONDS", "1")
    monkeypatch.setenv("ARDUINO_URL", "")
    settings = Settings.load(dotenv_path=tmp_path / "missing.env")
    assert settings.poll_interval_seconds == 5
    assert any("clamped" in warning.lower() for warning in settings.config_warnings)


def test_blank_arduino_url_is_not_hardcoded(monkeypatch, tmp_path):
    monkeypatch.delenv("ARDUINO_URL", raising=False)
    for key in ("WIND_SPEED_MPH", "LATITUDE", "LONGITUDE"):
        monkeypatch.delenv(key, raising=False)
    settings = Settings.load(dotenv_path=tmp_path / "missing.env")
    assert settings.arduino_url == ""
    assert settings.sensor_endpoint is None
