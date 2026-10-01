"""Read the DHT11 sketch from the Arduino's USB serial port."""

from __future__ import annotations

import asyncio
import logging

import httpx
import serial

from app.runtime import Runtime, utcnow
from app.sensor.client import FetchResult
from app.sensor.serial_proto import parse_serial_line

logger = logging.getLogger(__name__)


def open_serial(port: str, baud: int) -> serial.Serial:
    connection = serial.Serial()
    connection.port = port
    connection.baudrate = baud
    connection.timeout = 1
    connection.open()
    return connection


def _open_error(port: str, exc: Exception) -> str:
    text = str(exc)
    lowered = text.lower()
    if "access is denied" in lowered or "permission" in lowered:
        return f"{port} is in use. Close the Arduino Serial Monitor and the app will connect."
    if "cannot find the file" in lowered or "filenotfound" in lowered:
        return f"{port} is not connected."
    return f"Could not open {port}."


async def serial_session(runtime: Runtime, client: httpx.AsyncClient) -> None:
    port = runtime.settings.arduino_port
    baud = runtime.settings.arduino_baud
    try:
        connection = await asyncio.to_thread(open_serial, port, baud)
    except serial.SerialException as exc:
        runtime.apply_sensor_result(FetchResult(status="offline", error=_open_error(port, exc)))
        return
    logger.info("Reading DHT11 from %s at %s baud", port, baud)
    try:
        while True:
            raw = await asyncio.to_thread(connection.readline)
            now = utcnow()
            await _refresh_supplements(runtime, client, now)
            if not raw:
                continue
            parsed = parse_serial_line(raw.decode("utf-8", errors="replace"))
            if parsed is None:
                continue
            runtime.apply_sensor_result(parsed, now)
    except serial.SerialException:
        runtime.apply_sensor_result(
            FetchResult(status="offline", error=f"{port} disconnected."),
        )
    finally:
        await asyncio.to_thread(_close, connection)


def _close(connection: serial.Serial) -> None:
    try:
        connection.close()
    except serial.SerialException:
        return


async def _refresh_supplements(runtime: Runtime, client: httpx.AsyncClient, now) -> None:
    from app.poller import refresh_supplements

    await refresh_supplements(runtime, client, now)


async def serial_loop(runtime: Runtime) -> None:
    timeout = httpx.Timeout(runtime.settings.http_timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout) as client:
        while True:
            try:
                await serial_session(runtime, client)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Arduino serial session ended")
                runtime.apply_sensor_result(
                    FetchResult(status="offline", error="Arduino USB serial disconnected."),
                )
            await asyncio.sleep(3)
