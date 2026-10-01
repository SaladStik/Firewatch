"""sqlite3 import cleanup is handled in the module header."""

import json
import sqlite3
import threading
from pathlib import Path


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._init()

    def _init(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recorded_at TEXT NOT NULL,
                temperature_c REAL,
                humidity_pct REAL,
                wind_speed_mph REAL,
                wind_speed_source TEXT,
                inputs_json TEXT NOT NULL,
                risk_score REAL,
                category TEXT,
                confidence REAL,
                prediction_status TEXT NOT NULL,
                detail TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_observations_recorded_at
                ON observations (recorded_at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def insert_observation(
        self,
        *,
        recorded_at: str,
        temperature_c: float | None,
        humidity_pct: float | None,
        wind_speed_mph: float | None,
        wind_speed_source: str | None,
        inputs: dict,
        risk_score: float | None,
        category: str | None,
        prediction_status: str,
        detail: str | None,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO observations (
                    recorded_at, temperature_c, humidity_pct, wind_speed_mph,
                    wind_speed_source, inputs_json, risk_score, category,
                    confidence, prediction_status, detail
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    recorded_at,
                    temperature_c,
                    humidity_pct,
                    wind_speed_mph,
                    wind_speed_source,
                    json.dumps(inputs),
                    risk_score,
                    category,
                    prediction_status,
                    detail,
                ),
            )
            self._conn.commit()

    def recent(self, limit: int) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT recorded_at, temperature_c, humidity_pct, wind_speed_mph,
                       wind_speed_source, inputs_json, risk_score, category,
                       confidence, prediction_status, detail
                FROM observations
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            {
                "recorded_at": row["recorded_at"],
                "temperature_c": row["temperature_c"],
                "humidity_pct": row["humidity_pct"],
                "wind_speed_mph": row["wind_speed_mph"],
                "wind_speed_source": row["wind_speed_source"],
                "inputs": json.loads(row["inputs_json"]),
                "risk_score": row["risk_score"],
                "category": row["category"],
                "confidence": row["confidence"],
                "prediction_status": row["prediction_status"],
                "detail": row["detail"],
            }
            for row in rows
        ]

    def get_setting(self, key: str) -> str | None:
        with self._lock:
            row = self._conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        return row["value"]

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )
            self._conn.commit()

    def delete_setting(self, key: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM settings WHERE key = ?", (key,))
            self._conn.commit()
