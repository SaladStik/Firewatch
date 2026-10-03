const temperatureEl = document.querySelector("#temperature");
const humidityEl = document.querySelector("#humidity");
const stationId = new URLSearchParams(location.search).get("instrument");

function withStation(path) {
  if (!stationId) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}instrument=${encodeURIComponent(stationId)}`;
}

function windPayload(speed, source) {
  const body = { wind_speed_mph: speed, source };
  if (stationId) body.instrument = stationId;
  return JSON.stringify(body);
}

const sensorStatusEl = document.querySelector("#sensor-status");
const lastReadingEl = document.querySelector("#last-reading");
const sensorDetailEl = document.querySelector("#sensor-detail");
const sensorEndpointEl = document.querySelector("#sensor-endpoint");
const sensorCard = document.querySelector(".sensor-card");
const riskScoreEl = document.querySelector("#risk-score");
const riskUnitEl = document.querySelector("#risk-unit");
const riskCategoryEl = document.querySelector("#risk-category");
const riskMessageEl = document.querySelector("#risk-message");
const confidenceEl = document.querySelector("#confidence-note");
const modelInputsEl = document.querySelector("#model-inputs");
const windMphEl = document.querySelector("#wind-mph");
const windKmhEl = document.querySelector("#wind-kmh");
const windMsEl = document.querySelector("#wind-ms");
const windKnotsEl = document.querySelector("#wind-knots");
const factorListEl = document.querySelector("#factor-list");
const historyBody = document.querySelector("#history-body");
const appErrorEl = document.querySelector("#app-error");
const sensorChart = document.querySelector("#sensor-chart");
const riskChart = document.querySelector("#risk-chart");
const devToggle = document.querySelector("#dev-toggle");
const devPanel = document.querySelector("#dev-panel");
const devWindNote = document.querySelector("#dev-wind-note");
const devWindKeys = document.querySelector("#dev-wind-keys");
const devSim = document.querySelector("#dev-sim");
const devTempEl = document.querySelector("#dev-temp");
const devHumidityEl = document.querySelector("#dev-humidity");
const devWindEl = document.querySelector("#dev-wind");
if (stationId) devSim.hidden = false;
const themeToggle = document.querySelector("#theme-toggle");
const tickTempEl = document.querySelector("#tick-temp");
const tickHumidityEl = document.querySelector("#tick-humidity");
const tickWindEl = document.querySelector("#tick-wind");
const tickWindMoreEl = document.querySelector("#tick-wind-more");
const tickScoreEl = document.querySelector("#tick-score");
const tickBandEl = document.querySelector("#tick-band");
const tickSensorEl = document.querySelector("#tick-sensor");

let shownWindMph = null;
let windEase = null;
let keysOwnWind = false;

function paintEasedWind(mph) {
  paintWind(mph);
}

function windUnits(mph) {
  if (mph == null || Number.isNaN(Number(mph))) return null;
  const speed = Number(mph);
  return {
    mph: formatMeasure(speed, "mph", 1),
    kmh: formatMeasure(speed * 1.609344, "km/h", 1),
    ms: formatMeasure(speed * 0.44704, "m/s", 1),
    knots: formatMeasure(speed * (1.609344 / 1.852), "knots", 1),
  };
}

function formatWind(mph) {
  const units = windUnits(mph);
  if (!units) return "—";
  return `${units.mph} · ${units.kmh} · ${units.ms} · ${units.knots}`;
}

function paintWind(mph) {
  const units = windUnits(mph);
  windMphEl.textContent = units ? units.mph : "—";
  windKmhEl.textContent = units ? units.kmh : "—";
  windMsEl.textContent = units ? units.ms : "—";
  windKnotsEl.textContent = units ? units.knots : "—";
  tickWindEl.textContent = units ? units.mph : "—";
  tickWindMoreEl.textContent = units ? `${units.kmh} · ${units.ms} · ${units.knots}` : "";
}

const BANDS = {
  Low: "band-low",
  Moderate: "band-moderate",
  High: "band-high",
  "Very high": "band-very-high",
  Extreme: "band-extreme",
};

let historyKey = "";
let historyPoints = [];

function formatNumber(value, digits) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value).toFixed(digits).replace(/\.0$/, "");
}

function formatMeasure(value, unit, digits) {
  const text = formatNumber(value, digits);
  if (text == null) return "—";
  return unit ? `${text} ${unit}` : text;
}

function formatClock(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}

function statusClass(label) {
  if (label === "Connected") return "is-connected";
  if (label === "Sensor offline" || label === "Sensor read failed") return "is-offline";
  if (label === "Stale reading") return "is-stale";
  if (label === "Invalid sensor data") return "is-invalid";
  return "";
}

function bandClass(category) {
  return BANDS[category] || "";
}

function renderStatus(data) {
  const sensor = data.sensor || {};
  const prediction = data.prediction || {};
  const wind = data.wind || {};
  const connected = sensor.label === "Connected";

  temperatureEl.textContent = formatMeasure(sensor.temperature_c, "°C", 1);
  humidityEl.textContent = formatMeasure(sensor.humidity_pct, "%", 1);
  if (stationId) {
    devTempEl.textContent = formatMeasure(sensor.temperature_c, "°C", 1);
    devHumidityEl.textContent = formatMeasure(sensor.humidity_pct, "%", 0);
    devWindEl.textContent = formatMeasure(wind.speed_mph, "mph", 1);
  }
  if (sensorStatusEl) {
    sensorStatusEl.textContent = sensor.label || "—";
    sensorStatusEl.className = statusClass(sensor.label);
  }
  lastReadingEl.textContent = formatClock(sensor.last_reading);
  sensorDetailEl.textContent = sensor.detail || "";
  sensorCard.classList.toggle("is-dim", !connected);

  if (sensor.connection === "usb" && sensor.endpoint) {
    sensorEndpointEl.textContent = `USB serial ${sensor.endpoint}. The sketch prints a reading about every 3 seconds. Readings older than ${data.stale_after_seconds} seconds are not used for a current estimate.`;
  } else if (sensor.endpoint) {
    sensorEndpointEl.textContent = `Polling ${sensor.endpoint} about every ${data.poll_interval_seconds} seconds. Readings older than ${data.stale_after_seconds} seconds are not used for a current estimate.`;
  } else {
    sensorEndpointEl.textContent = "Set ARDUINO_PORT for a USB Arduino, or ARDUINO_URL for Wi-Fi.";
  }

  const available = prediction.state === "ok" && prediction.risk_score != null;
  const tone = available ? bandClass(prediction.category) : "";
  riskScoreEl.textContent = available ? formatNumber(prediction.risk_score, 1) : "Unavailable";
  riskScoreEl.className = `score${available ? "" : " is-unavailable"}${tone ? ` ${tone}` : ""}`;
  riskUnitEl.textContent = available ? "Fosberg index, 0–100" : "";
  riskCategoryEl.textContent = available ? prediction.category : "";
  riskMessageEl.textContent = prediction.message || "";
  confidenceEl.textContent = prediction.confidence == null ? "" : `Confidence: ${prediction.confidence}`;

  modelInputsEl.replaceChildren();
  for (const input of prediction.inputs || []) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = input.label;
    const value = document.createElement("span");
    const shown = formatMeasure(input.value, input.unit, 1);
    const usage = input.used_by_model ? "Used for this estimate." : "Not used for the current estimate.";
    if (input.name === "wind_speed_mph") {
      const units = windUnits(input.value);
      const listed = units ? `${units.mph} · ${units.kmh} · ${units.ms} · ${units.knots}` : "—";
      value.textContent = `${listed}. ${usage}`;
    } else {
      value.textContent = `${shown} · ${input.source}. ${usage}`;
    }
    item.append(title, document.createTextNode(" "), value);
    modelInputsEl.append(item);
  }

  if (!windEase && !keysOwnWind) {
    if (wind.speed_mph != null) shownWindMph = Number(wind.speed_mph);
    paintWind(wind.speed_mph);
  }
  tickTempEl.textContent = formatMeasure(sensor.temperature_c, "°C", 1);
  tickHumidityEl.textContent = formatMeasure(sensor.humidity_pct, "%", 1);
  tickScoreEl.textContent = available ? formatNumber(prediction.risk_score, 1) : "—";
  tickScoreEl.className = `${available ? "" : "is-unavailable"}${tone ? ` ${tone}` : ""}`.trim();
  tickBandEl.textContent = available ? prediction.category : "—";
  tickBandEl.className = `${available ? "" : "is-unavailable"}${tone ? ` ${tone}` : ""}`.trim();
  if (tickSensorEl) {
    tickSensorEl.textContent = sensor.label || "—";
    tickSensorEl.className = statusClass(sensor.label);
  }

  factorListEl.replaceChildren();
  for (const factor of data.not_used_by_model || []) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = factor.label;
    const value = document.createElement("span");
    value.textContent = factor.value == null
      ? "Not collected"
      : `${formatMeasure(factor.value, factor.unit, 1)} · observed, not used by the model`;
    const why = document.createElement("p");
    why.textContent = `${factor.why} Possible source: ${factor.source_hint}`;
    item.append(title, document.createTextNode(" "), value, why);
    factorListEl.append(item);
  }
}

function renderHistory(points) {
  const rows = points.slice(-12).reverse();
  historyBody.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "No readings yet.";
    row.append(cell);
    historyBody.append(row);
  }
  for (const point of rows) {
    const row = document.createElement("tr");
    const cells = [
      formatClock(point.recorded_at),
      formatMeasure(point.temperature_c, "°C", 1),
      formatMeasure(point.humidity_pct, "%", 1),
      formatWind(point.wind_speed_mph),
      point.risk_score == null ? "withheld" : formatNumber(point.risk_score, 1),
      point.category || "—",
    ];
    cells.forEach((text, index) => {
      const cell = document.createElement("td");
      if (index === 5 && point.category) {
        const mark = document.createElement("span");
        mark.className = `band-label ${bandClass(point.category)}`;
        mark.textContent = text;
        cell.append(mark);
      } else {
        cell.textContent = text;
      }
      row.append(cell);
    });
    historyBody.append(row);
  }
  drawSensorChart(points);
  drawRiskChart(points);
}

function prepare(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(rect.width, 280);
  const height = 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawEmpty(ctx, width, height, message) {
  ctx.fillStyle = cssColor("--chart-label");
  ctx.font = "14px Consolas, Cascadia Mono, monospace";
  ctx.fillText(message, 16, height / 2);
}

function drawLine(ctx, points, xAt, yAt, color) {
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  let drawing = false;
  points.forEach((point, index) => {
    const y = yAt(point);
    if (y == null) {
      drawing = false;
      return;
    }
    const x = xAt(index);
    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  points.forEach((point, index) => {
    const y = yAt(point);
    if (y == null) return;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(xAt(index), y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawSensorChart(points) {
  const { ctx, width, height } = prepare(sensorChart);
  if (!points.length) {
    drawEmpty(ctx, width, height, "No sensor history yet.");
    return;
  }
  const pad = { left: 36, right: 36, top: 12, bottom: 16 };
  const temps = points.map((point) => point.temperature_c).filter((value) => value != null);
  let minT = Math.min(...temps);
  let maxT = Math.max(...temps);
  if (!Number.isFinite(minT) || !Number.isFinite(maxT)) {
    minT = 0;
    maxT = 1;
  }
  if (minT === maxT) {
    minT -= 1;
    maxT += 1;
  }
  const xAt = (index) => {
    if (points.length === 1) return width / 2;
    return pad.left + (index / (points.length - 1)) * (width - pad.left - pad.right);
  };
  const yTemp = (point) => {
    if (point.temperature_c == null) return null;
    const span = maxT - minT;
    return pad.top + (1 - (point.temperature_c - minT) / span) * (height - pad.top - pad.bottom);
  };
  const yHum = (point) => {
    if (point.humidity_pct == null) return null;
    return pad.top + (1 - point.humidity_pct / 100) * (height - pad.top - pad.bottom);
  };
  ctx.strokeStyle = cssColor("--chart-axis");
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, height - pad.bottom);
  ctx.lineTo(width - pad.right, height - pad.bottom);
  ctx.stroke();
  drawLine(ctx, points, xAt, yTemp, cssColor("--chart-temp"));
  drawLine(ctx, points, xAt, yHum, cssColor("--chart-hum"));
  ctx.fillStyle = cssColor("--chart-label");
  ctx.font = "11px Consolas, Cascadia Mono, monospace";
  ctx.fillText("°C", 6, 14);
  ctx.fillText("%", width - 22, 14);
}

function drawRiskChart(points) {
  const { ctx, width, height } = prepare(riskChart);
  if (!points.length) {
    drawEmpty(ctx, width, height, "No model history yet.");
    return;
  }
  const pad = { left: 32, right: 12, top: 12, bottom: 16 };
  const xAt = (index) => {
    if (points.length === 1) return width / 2;
    return pad.left + (index / (points.length - 1)) * (width - pad.left - pad.right);
  };
  const yScore = (point) => {
    if (point.risk_score == null) return null;
    return pad.top + (1 - point.risk_score / 100) * (height - pad.top - pad.bottom);
  };
  ctx.strokeStyle = cssColor("--chart-axis");
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, height - pad.bottom);
  ctx.lineTo(width - pad.right, height - pad.bottom);
  ctx.stroke();
  drawLine(ctx, points, xAt, yScore, cssColor("--chart-risk"));
  ctx.fillStyle = cssColor("--chart-label");
  ctx.font = "11px Consolas, Cascadia Mono, monospace";
  ctx.fillText("0–100", 4, 14);
}

async function loadStatus() {
  const response = await fetch(withStation("/api/status"), { cache: "no-store" });
  if (!response.ok) throw new Error("status failed");
  renderStatus(await response.json());
  appErrorEl.hidden = true;
}

async function loadHistory() {
  const response = await fetch(withStation("/api/history?limit=500"), { cache: "no-store" });
  if (!response.ok) throw new Error("history failed");
  const payload = await response.json();
  const points = payload.points || [];
  historyPoints = points;
  const key = points.length ? `${points.length}:${points[points.length - 1].recorded_at}:${points[points.length - 1].risk_score}` : "empty";
  if (key === historyKey) return;
  historyKey = key;
  renderHistory(points);
}

async function refresh() {
  try {
    await loadStatus();
    await loadHistory();
  } catch (error) {
    appErrorEl.hidden = false;
  }
}

function setDevOpen(open) {
  devPanel.hidden = !open;
  devToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

devToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  setDevOpen(devPanel.hidden);
});

devSim.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !stationId) return;
  if (button.dataset.windStep) {
    const current = shownWindMph == null ? 0 : shownWindMph;
    const speed = Math.min(200, Math.max(0, Math.round((current + Number(button.dataset.windStep)) * 10) / 10));
    fetch("/api/wind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: windPayload(speed, "dev: arrows"),
    }).then(async (response) => {
      if (!response.ok) return;
      renderStatus(await response.json());
      historyKey = "";
      loadHistory();
    }).catch(() => {});
    return;
  }
  const body = { instrument: stationId };
  if (button.dataset.temp) body.temperature_delta = Number(button.dataset.temp);
  if (button.dataset.humidity) body.humidity_delta = Number(button.dataset.humidity);
  if (body.temperature_delta == null && body.humidity_delta == null) return;
  fetch("/api/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => {
    if (!response.ok) return;
    renderStatus(await response.json());
    historyKey = "";
    loadHistory();
  }).catch(() => {});
});

document.addEventListener("click", (event) => {
  if (!devPanel.hidden && !event.target.closest(".dev-wrap")) {
    setDevOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setDevOpen(false);
  if (!devWindKeys.checked) return;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" && event.target !== devWindKeys) return;
  if (tag === "TEXTAREA" || tag === "SELECT") return;
  event.preventDefault();
  nudgeWind(event.key === "ArrowUp" ? 1 : -1);
});

let keyPostTimer = 0;
let keyLastPostAt = 0;
let keyChain = Promise.resolve();

function nudgeWind(delta) {
  if (windEase) {
    windEase.cancelled = true;
    cancelAnimationFrame(windEase.frame);
    windEase = null;
  }
  keysOwnWind = true;
  const from = shownWindMph == null ? 0 : shownWindMph;
  const speed = Math.min(200, Math.max(0, Math.round((from + delta) * 10) / 10));
  shownWindMph = speed;
  paintEasedWind(speed, "arrow keys");
  devWindNote.textContent = `${formatMeasure(speed, "mph", 1)} from the arrow keys.`;
  if (keyPostTimer) return;
  const wait = Math.max(0, 400 - (performance.now() - keyLastPostAt));
  keyPostTimer = setTimeout(() => {
    keyPostTimer = 0;
    keyLastPostAt = performance.now();
    postKeyWind(shownWindMph);
  }, wait);
}

function postKeyWind(speed) {
  keyChain = keyChain.then(async () => {
    const response = await fetch("/api/wind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: windPayload(speed, "dev: arrow keys"),
    });
    if (!response.ok) {
      devWindNote.textContent = "Could not save that wind choice.";
      return;
    }
    if (shownWindMph === speed) keysOwnWind = false;
    renderStatus(await response.json());
    if (shownWindMph === speed) {
      historyKey = "";
      loadHistory();
    }
  }).catch(() => {
    devWindNote.textContent = "Could not save that wind choice.";
  });
}

document.querySelector(".dev-choices").addEventListener("click", (event) => {
  const choice = event.target.closest("button[data-wind]");
  if (!choice) return;
  easeWindTo(Number(choice.dataset.wind), choice.dataset.label);
});

function easeWindTo(target, label) {
  if (windEase) {
    windEase.cancelled = true;
    cancelAnimationFrame(windEase.frame);
  }
  const from = shownWindMph == null ? 0 : shownWindMph;
  if (from === target) {
    commitWind(target, label, true);
    return;
  }
  const run = { cancelled: false, frame: 0, lastSent: null, lastPostAt: 0, chain: Promise.resolve() };
  windEase = run;
  const duration = Math.min(14000, Math.max(4000, Math.abs(target - from) * 400));
  const started = performance.now();
  devWindNote.textContent = `Easing from ${from.toFixed(1)} mph to ${label} (${target} mph).`;

  const frame = (now) => {
    if (run.cancelled) return;
    const progress = Math.min(1, (now - started) / duration);
    const curve = progress * progress * (3 - 2 * progress);
    const arrived = progress === 1;
    const speed = arrived ? target : Math.round((from + (target - from) * curve) * 10) / 10;
    shownWindMph = speed;
    paintEasedWind(speed, label);
    const moved = run.lastSent == null || Math.abs(speed - run.lastSent) >= 1 || arrived;
    if (moved && speed !== run.lastSent && (arrived || now - run.lastPostAt >= 450)) {
      run.lastPostAt = now;
      run.lastSent = speed;
      const posted = speed;
      run.chain = run.chain.then(async () => {
        if (run.cancelled) return;
        const response = await fetch("/api/wind", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: windPayload(posted, `dev: ${label}`),
        });
        if (!response.ok) {
          devWindNote.textContent = "Could not save that wind choice.";
          return;
        }
        if (!run.cancelled) renderStatus(await response.json());
      }).catch(() => {
        if (!run.cancelled) devWindNote.textContent = "Could not save that wind choice.";
      });
    }
    if (!arrived) {
      run.frame = requestAnimationFrame(frame);
      return;
    }
    run.chain.then(() => {
      if (run.cancelled) return;
      windEase = null;
      devWindNote.textContent = `${label}: ${target} mph. Stand-in data for the model, not a measured wind.`;
      historyKey = "";
      loadHistory();
    });
  };
  run.frame = requestAnimationFrame(frame);
}

function commitWind(target, label) {
  shownWindMph = target;
  paintEasedWind(target, label);
  fetch("/api/wind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: windPayload(target, `dev: ${label}`),
  }).then(async (response) => {
    if (!response.ok) {
      devWindNote.textContent = "Could not save that wind choice.";
      return;
    }
    windEase = null;
    renderStatus(await response.json());
    devWindNote.textContent = `${label}: ${target} mph. Stand-in data for the model, not a measured wind.`;
    historyKey = "";
    loadHistory();
  }).catch(() => {
    devWindNote.textContent = "Could not save that wind choice.";
  });
}

window.addEventListener("resize", () => {
  historyKey = "";
  loadHistory().catch(() => {});
});

function applyTheme(theme) {
  const light = theme === "light";
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  themeToggle.textContent = light ? "Dark" : "Light";
  themeToggle.setAttribute("aria-pressed", light ? "true" : "false");
  try {
    localStorage.setItem("wildfire-theme", light ? "light" : "dark");
  } catch (error) {}
  if (historyPoints.length) renderHistory(historyPoints);
}

themeToggle.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

if (window.parent !== window) themeToggle.hidden = true;

applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

refresh();
setInterval(refresh, 3000);
