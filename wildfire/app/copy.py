"""User-facing wording. The score is a research estimate, not an official warning."""

DISCLAIMER = (
    "Research prototype only. This model risk estimate is not an official wildfire "
    "warning, watch, or emergency alert. For official information, use your local "
    "fire agency and weather service."
)

MODEL_NAME = "Fosberg Fire Weather Index (1978)"

MODEL_REFERENCE = (
    "Fosberg, M.A. 1978. Weather in wildland fire management: the Fire Weather Index. "
    "Equilibrium moisture equations follow the form published with the University of "
    "Washington WRF Fosberg index description. An index of 100 corresponds to zero "
    "moisture content and a 30 mph wind; higher combinations are capped at 100."
)

CATEGORY_NOTE = ""

CONFIDENCE_NOTE = ""

MODEL_INPUTS = (
    "temperature_c",
    "relative_humidity_pct",
    "wind_speed_mph",
)

# Equal slices of the 0-100 index for display only. Not agency criteria.
DISPLAY_BANDS = (
    (20, "Low"),
    (40, "Moderate"),
    (60, "High"),
    (80, "Very high"),
    (101, "Extreme"),
)
