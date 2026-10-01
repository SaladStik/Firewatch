from datetime import timedelta

from app.sensor.client import FetchResult
from app.supplements import SupplementResult, open_meteo_params, parse_open_meteo
from tests.conftest import make_settings, utc


def test_connected_prediction_records_history_without_confidence(runtime):
    now = utc()
    runtime.set_manual_wind(10, "anemometer", now)
    runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0), now)
    view = runtime.status(now)
    assert view["sensor"]["label"] == "Connected"
    assert view["sensor"]["temperature_c"] == 23.4
    assert view["sensor"]["humidity_pct"] == 42.0
    assert view["prediction"]["state"] == "ok"
    assert view["prediction"]["risk_score"] is not None
    assert view["prediction"]["confidence"] is None
    assert view["prediction"]["official_warning"] is False
    assert view["sensor"]["role"] == "environmental_input"
    rows = runtime.store.recent(10)
    assert rows[0]["temperature_c"] == 23.4
    assert rows[0]["humidity_pct"] == 42.0
    assert rows[0]["risk_score"] is not None
    assert rows[0]["confidence"] is None
    assert rows[0]["inputs"]["model_inputs"] == [
        "temperature_c",
        "relative_humidity_pct",
        "wind_speed_mph",
    ]


def test_missing_wind_keeps_the_sensor_reading_and_withholds_the_score(runtime):
    now = utc()
    runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0), now)
    view = runtime.status(now)
    assert view["sensor"]["label"] == "Connected"
    assert view["sensor"]["temperature_c"] == 23.4
    assert view["prediction"]["state"] == "missing_inputs"
    assert view["prediction"]["missing_inputs"] == ["wind_speed_mph"]
    assert view["prediction"]["risk_score"] is None
    assert view["prediction"]["confidence"] is None
    row = runtime.store.recent(1)[0]
    assert row["temperature_c"] == 23.4
    assert row["risk_score"] is None
    assert row["prediction_status"] == "missing_inputs"


def test_arduino_offline_does_not_raise_and_can_recover(runtime):
    now = utc()
    runtime.set_manual_wind(10, "anemometer", now)
    runtime.apply_sensor_result(FetchResult(status="offline", error="Arduino unreachable"), now)
    offline = runtime.status(now)
    assert offline["sensor"]["label"] == "Sensor offline"
    assert offline["sensor"]["temperature_c"] is None
    assert offline["prediction"]["risk_score"] is None

    runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=21.0, humidity_pct=50.0), now)
    recovered = runtime.status(now)
    assert recovered["sensor"]["label"] == "Connected"
    assert recovered["prediction"]["state"] == "ok"
    assert recovered["prediction"]["confidence"] is None


def test_stale_reading_is_not_presented_as_current(runtime):
    start = utc()
    runtime.set_manual_wind(12, "anemometer", start)
    runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0), start)
    later = start + timedelta(seconds=31)
    view = runtime.status(later)
    assert view["sensor"]["label"] == "Stale reading"
    assert view["sensor"]["temperature_c"] == 23.4
    assert view["prediction"]["state"] == "stale_sensor"
    assert view["prediction"]["risk_score"] is None
    assert view["prediction"]["confidence"] is None


def test_reading_is_still_fresh_at_the_stale_boundary(runtime):
    start = utc()
    runtime.set_manual_wind(12, "anemometer", start)
    runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0), start)
    view = runtime.status(start + timedelta(seconds=30))
    assert view["sensor"]["label"] == "Connected"
    assert view["prediction"]["state"] == "ok"


def test_failed_attempt_does_not_drop_a_fresh_reading(runtime):
    start = utc()
    runtime.set_manual_wind(10, "anemometer", start)
    runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0), start)
    runtime.apply_sensor_result(
        FetchResult(status="read_failure", error="dht_read_failure"),
        start + timedelta(seconds=8),
    )
    view = runtime.status(start + timedelta(seconds=8))
    assert view["sensor"]["label"] == "Connected"
    assert view["sensor"]["temperature_c"] == 23.4
    assert "dht_read_failure" in (view["sensor"]["detail"] or "")
    assert view["prediction"]["state"] == "ok"


def test_invalid_payload_without_a_prior_reading(runtime):
    now = utc()
    runtime.apply_sensor_result(FetchResult(status="invalid", error="humidity is outside 0 to 100 percent"), now)
    view = runtime.status(now)
    assert view["sensor"]["label"] == "Invalid sensor data"
    assert view["prediction"]["state"] == "invalid_sensor"
    assert view["prediction"]["risk_score"] is None


def test_open_meteo_wind_is_used_only_as_wind_and_not_as_temperature(tmp_path):
    settings = make_settings(tmp_path, latitude=51.0, longitude=-114.0)
    from app.runtime import Runtime
    from app.store import Store

    store = Store(settings.sqlite_path)
    runtime = Runtime(settings, store)
    try:
        now = utc()
        parsed = parse_open_meteo(
            {
                "current": {
                    "wind_speed_10m": 8.5,
                    "wind_direction_10m": 220,
                    "precipitation": 0.2,
                    "surface_pressure": 1013.0,
                }
            }
        )
        runtime.apply_supplement(parsed, now)
        runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0), now)
        view = runtime.status(now)
        assert view["sensor"]["temperature_c"] == 23.4
        assert view["wind"]["origin"] == "open-meteo"
        assert view["wind"]["speed_mph"] == 8.5
        assert view["prediction"]["state"] == "ok"
        direction = next(item for item in view["not_used_by_model"] if item["label"] == "Wind direction")
        rain = next(item for item in view["not_used_by_model"] if item["label"] == "Precipitation")
        assert direction["value"] == 220
        assert direction["used_by_model"] is False
        assert rain["value"] == 0.2
        assert rain["used_by_model"] is False
        assert "temperature_2m" not in open_meteo_params(51.0, -114.0)["current"]
    finally:
        store.close()


def test_open_meteo_failure_leaves_the_score_withheld(runtime):
    now = utc()
    runtime.apply_supplement(SupplementResult(ok=False, error="Open-Meteo was unreachable"), now)
    runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=23.4, humidity_pct=42.0), now)
    view = runtime.status(now)
    assert view["sensor"]["label"] == "Connected"
    assert view["prediction"]["state"] == "missing_inputs"
    assert any("Open-Meteo" in warning for warning in view["warnings"])


def test_dashboard_wind_overrides_environment(tmp_path):
    settings = make_settings(tmp_path, wind_speed_mph=3)
    from app.runtime import Runtime
    from app.store import Store

    store = Store(settings.sqlite_path)
    runtime = Runtime(settings, store)
    try:
        now = utc()
        runtime.apply_sensor_result(FetchResult(status="ok", temperature_c=18, humidity_pct=60), now)
        before = runtime.status(now)
        assert before["wind"]["origin"] == "environment"
        runtime.set_manual_wind(15, "handheld", now)
        after = runtime.status(now)
        assert after["wind"]["speed_mph"] == 15
        assert after["wind"]["origin"] == "dashboard"
        runtime.clear_manual_wind(now)
        cleared = runtime.status(now)
        assert cleared["wind"]["speed_mph"] == 3
        assert cleared["wind"]["origin"] == "environment"
    finally:
        store.close()
