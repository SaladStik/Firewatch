from app.sensor.ports import detect_arduino_port
from app.sensor.serial_proto import parse_serial_line
from tests.conftest import utc


def test_parse_temperature_and_humidity_line():
    result = parse_serial_line("TEMP:23.40,HUMIDITY:42.00")
    assert result is not None
    assert result.status == "ok"
    assert result.temperature_c == 23.4
    assert result.humidity_pct == 42.0


def test_ready_line_is_ignored():
    assert parse_serial_line("DHT11_READY") is None
    assert parse_serial_line("   ") is None


def test_dht_error_line():
    result = parse_serial_line("ERROR")
    assert result.status == "read_failure"
    assert result.error == "dht_read_failure"


def test_unrecognized_serial_line():
    result = parse_serial_line("TEMP:hot,HUMIDITY:42")
    assert result.status == "malformed"


def test_out_of_range_humidity_from_serial():
    result = parse_serial_line("TEMP:23.40,HUMIDITY:140.00")
    assert result.status == "invalid"


def test_serial_reading_reaches_the_model(runtime):
    now = utc()
    runtime.set_manual_wind(10, "anemometer", now)
    runtime.apply_sensor_result(parse_serial_line("TEMP:23.40,HUMIDITY:42.00"), now)
    view = runtime.status(now)
    assert view["sensor"]["label"] == "Connected"
    assert view["sensor"]["temperature_c"] == 23.4
    assert view["sensor"]["humidity_pct"] == 42.0
    assert view["prediction"]["state"] == "ok"
    assert view["prediction"]["confidence"] is None


def test_serial_error_does_not_crash(runtime):
    now = utc()
    runtime.apply_sensor_result(parse_serial_line("ERROR"), now)
    view = runtime.status(now)
    assert view["sensor"]["label"] == "Sensor read failed"
    assert view["prediction"]["risk_score"] is None


class _Port:
    def __init__(self, device, vid):
        self.device = device
        self.vid = vid


def test_detects_the_only_arduino():
    assert detect_arduino_port([_Port("COM6", 0x2341)]) == "COM6"


def test_does_not_guess_when_two_arduinos_are_present():
    ports = [_Port("COM5", 0x2341), _Port("COM6", 0x2341)]
    assert detect_arduino_port(ports) is None


def test_ignores_non_arduino_adapters():
    assert detect_arduino_port([_Port("COM3", 0x1A86)]) is None
