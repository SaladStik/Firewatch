"""Find an Arduino on USB. A single Arduino board is selected automatically."""

from __future__ import annotations

ARDUINO_VID = 0x2341


def detect_arduino_port(comports=None) -> str | None:
    if comports is None:
        from serial.tools.list_ports import comports as list_comports

        comports = list_comports()
    matches = [port.device for port in comports if getattr(port, "vid", None) == ARDUINO_VID and port.device]
    if len(matches) == 1:
        return matches[0]
    return None
