import pytest

from app.sensor.parse import SensorParseError, SensorReadFailure, parse_sensor_payload


def test_parse_arduino_example():
    reading = parse_sensor_payload({"temperature": 23.4, "humidity": 42.0, "unit": "C"})
    assert reading.temperature_c == 23.4
    assert reading.humidity_pct == 42.0


def test_parse_accepts_ok_flag_and_integer_humidity():
    reading = parse_sensor_payload({"ok": True, "temperature": 20, "humidity": 40, "unit": "°C"})
    assert reading.temperature_c == 20
    assert reading.humidity_pct == 40


def test_dht_read_failure_is_not_a_reading():
    with pytest.raises(SensorReadFailure):
        parse_sensor_payload(
            {
                "ok": False,
                "error": "dht_read_failure",
                "temperature": None,
                "humidity": None,
                "unit": "C",
            }
        )


def test_invalid_humidity_is_rejected():
    with pytest.raises(SensorParseError):
        parse_sensor_payload({"temperature": 23.4, "humidity": 140, "unit": "C"})


def test_missing_temperature_is_rejected():
    with pytest.raises(SensorParseError):
        parse_sensor_payload({"humidity": 42})


def test_non_numeric_temperature_is_rejected():
    with pytest.raises(SensorParseError):
        parse_sensor_payload({"temperature": "hot", "humidity": 42, "unit": "C"})


def test_fahrenheit_unit_is_rejected():
    with pytest.raises(SensorParseError, match="unit"):
        parse_sensor_payload({"temperature": 70, "humidity": 42, "unit": "F"})


def test_json_list_is_rejected():
    with pytest.raises(SensorParseError):
        parse_sensor_payload([23.4, 42])
