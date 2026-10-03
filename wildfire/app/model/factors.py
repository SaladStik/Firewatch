"""Environmental factors this prototype does not score."""

FACTORS = (
    {
        "key": "wind_direction_deg",
        "label": "Wind direction",
        "unit": "°",
        "why": "Changes the direction a fire would spread. The Fosberg index uses wind speed only.",
        "source_hint": "A local anemometer, or Open-Meteo when LATITUDE and LONGITUDE are set.",
    },
    {
        "key": "precipitation_mm",
        "label": "Precipitation",
        "unit": "mm",
        "why": "Recent rain changes actual fuel moisture. This index only estimates equilibrium moisture from temperature and humidity.",
        "source_hint": "A rain gauge, a nearby station, or Open-Meteo.",
    },
    {
        "key": None,
        "label": "Drought and fuel moisture",
        "unit": "",
        "why": "Dead-fuel moisture, drought indices, and live fuel moisture dominate real fire danger. This station does not measure them.",
        "source_hint": "RAWS, gridMET, or the National Fire Danger Rating System.",
    },
    {
        "key": "surface_pressure_hpa",
        "label": "Atmospheric pressure",
        "unit": "hPa",
        "why": "Useful weather context. Not an input to this index.",
        "source_hint": "A barometer or Open-Meteo.",
    },
    {
        "key": None,
        "label": "Vegetation and fuel type",
        "unit": "",
        "why": "The index assumes one fixed fine-fuel bed instead of the vegetation at this site.",
        "source_hint": "LANDFIRE or a local fuel-model survey.",
    },
    {
        "key": None,
        "label": "Elevation, slope, and aspect",
        "unit": "",
        "why": "Topography changes drying and spread. Not an input to this index.",
        "source_hint": "USGS 3DEP or a site survey.",
    },
    {
        "key": None,
        "label": "Historical fire occurrence",
        "unit": "",
        "why": "This index is a weather filter, not a probability that a fire will start.",
        "source_hint": "NIFC fire perimeters or MTBS.",
    },
)
