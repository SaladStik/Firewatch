"""Background poll of the Arduino and optional supplemental weather."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import httpx

from app.runtime import Runtime, utcnow
from app.sensor.client import FetchResult, fetch_sensor
from app.supplements import fetch_open_meteo

logger = logging.getLogger(__name__)


async def refresh_supplements(runtime: Runtime, client: httpx.AsyncClient, now: datetime) -> None:
    if not runtime.supplement_is_due(now):
        return
    latitude = runtime.settings.latitude
    longitude = runtime.settings.longitude
    if latitude is None or longitude is None:
        return
    try:
        result = await fetch_open_meteo(client, latitude, longitude)
    except Exception:
        logger.exception("Supplemental weather update failed")
        return
    runtime.apply_supplement(result, now)


async def poll_once(
    runtime: Runtime,
    client: httpx.AsyncClient,
    now: datetime | None = None,
) -> None:
    now = now or utcnow()
    supplement_task = asyncio.create_task(refresh_supplements(runtime, client, now))
    try:
        endpoint = runtime.settings.sensor_endpoint
        if endpoint:
            sensor_result = await fetch_sensor(client, endpoint)
        else:
            sensor_result = FetchResult(
                status="not_configured",
                error="No Arduino is configured. Set ARDUINO_PORT for USB or ARDUINO_URL for Wi-Fi.",
            )
        await supplement_task
    except asyncio.CancelledError:
        supplement_task.cancel()
        raise
    except Exception:
        if not supplement_task.done():
            supplement_task.cancel()
        raise
    runtime.apply_sensor_result(sensor_result, now)


async def sensor_loop(runtime: Runtime) -> None:
    if runtime.settings.arduino_port:
        from app.sensor.serial_reader import serial_loop

        await serial_loop(runtime)
        return
    await poll_loop(runtime)


async def poll_loop(runtime: Runtime) -> None:
    timeout = httpx.Timeout(runtime.settings.http_timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout) as client:
        while True:
            try:
                await poll_once(runtime, client)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unexpected sensor poll error")
            await asyncio.sleep(runtime.settings.poll_interval_seconds)
