import pytest

from app.copy import MODEL_INPUTS
from app.model.fosberg import compute_fosberg, equilibrium_moisture_content
from app.model.pipeline import assess


def test_equilibrium_moisture_reference():
    # 0 C is 32 F. At 50% humidity the middle branch is:
    # 2.22749 + 0.160107*50 - 0.01478*32 = 9.75988
    assert equilibrium_moisture_content(32, 50) == pytest.approx(9.75988, abs=1e-4)


def test_reference_fosberg_score():
    # 30 C, 20% RH, 20 mph. Hand evaluation of the published equation is about 50.05.
    result = compute_fosberg(30.0, 20.0, 20.0)
    assert result.risk_score == pytest.approx(50.05, abs=0.05)
    assert result.category == "High"


def test_drier_air_and_stronger_wind_raise_the_index():
    humid = compute_fosberg(30, 80, 10).risk_score
    dry = compute_fosberg(30, 15, 10).risk_score
    calm = compute_fosberg(30, 15, 0).risk_score
    windy = compute_fosberg(30, 15, 25).risk_score
    assert dry > humid
    assert windy > calm


def test_index_is_capped_at_100():
    result = compute_fosberg(43.3, 1, 40)
    assert result.risk_score == 100
    assert result.capped is True
    assert result.category == "Extreme"


def test_successful_prediction_from_sensor_inputs_has_no_invented_confidence():
    assessment = assess(
        temperature_c=23.4,
        humidity_pct=42.0,
        wind_speed_mph=10,
        wind_speed_source="manual",
        reading_is_fresh=True,
        failure_kind=None,
    )
    assert assessment.state == "ok"
    assert assessment.risk_score is not None
    assert assessment.category
    assert assessment.confidence is None
    assert assessment.official_warning is False
    assert assessment.temperature_c == 23.4
    assert assessment.humidity_pct == 42.0
    assert assessment.wind_speed_mph == 10


def test_missing_wind_does_not_score_temperature_and_humidity_alone():
    assessment = assess(
        temperature_c=23.4,
        humidity_pct=42.0,
        wind_speed_mph=None,
        wind_speed_source=None,
        reading_is_fresh=True,
        failure_kind=None,
    )
    assert assessment.state == "missing_inputs"
    assert assessment.missing_inputs == ("wind_speed_mph",)
    assert assessment.risk_score is None
    assert assessment.confidence is None
    assert assessment.temperature_c == 23.4


def test_stale_reading_is_not_scored():
    assessment = assess(
        temperature_c=23.4,
        humidity_pct=42.0,
        wind_speed_mph=10,
        wind_speed_source="manual",
        reading_is_fresh=False,
        failure_kind=None,
    )
    assert assessment.state == "stale_sensor"
    assert assessment.risk_score is None


def test_model_error_is_contained():
    def boom(*args, **kwargs):
        raise RuntimeError("formula failed")

    assessment = assess(
        temperature_c=23.4,
        humidity_pct=42.0,
        wind_speed_mph=10,
        wind_speed_source="manual",
        reading_is_fresh=True,
        failure_kind=None,
        compute=boom,
    )
    assert assessment.state == "model_error"
    assert assessment.risk_score is None
    assert assessment.confidence is None


def test_precipitation_is_not_a_model_input():
    assert MODEL_INPUTS == ("temperature_c", "relative_humidity_pct", "wind_speed_mph")
    joined = " ".join(MODEL_INPUTS)
    assert "precipitation" not in joined
    assert "fuel" not in joined
