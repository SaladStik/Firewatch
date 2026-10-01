/** Live collectors: each instrument is one data source, listed with its location. */
import { useEffect, useState } from "react";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { ThemeToggle } from "./Hud";
import { KV } from "./primitives";

const INSTRUMENTS_URL = "http://127.0.0.1:8000/api/instruments";

type Reading = {
  ok: boolean;
  label: string;
  temperature_c: number | null;
  humidity_pct: number | null;
  wind_mph: number | null;
  risk_score: number | null;
  category: string | null;
  detail: string | null;
  endpoint: string | null;
};

type Instrument = {
  id: string;
  name: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  kind: string;
  dashboard: string | null;
  reading: Reading;
};

function coords(latitude: number | null, longitude: number | null) {
  if (latitude == null || longitude == null) return null;
  const ns = latitude >= 0 ? "N" : "S";
  const ew = longitude >= 0 ? "E" : "W";
  return `${Math.abs(latitude).toFixed(4)}° ${ns}, ${Math.abs(longitude).toFixed(4)}° ${ew}`;
}

function dashboardUrl(base: string, theme: "dark" | "light") {
  const url = new URL(base);
  url.searchParams.set("theme", theme);
  return url.toString();
}

function metric(value: number | null, digits: number, unit: string) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}${unit}`;
}

export function InstrumentData({ onBack, engine }: { onBack: () => void; engine: Engine | null }) {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(INSTRUMENTS_URL, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { instruments?: Instrument[] };
        if (cancelled) return;
        const rows = body.instruments ?? [];
        setInstruments(rows);
        setError(null);
        setSelectedId((current) => current ?? rows[0]?.id ?? null);
      } catch {
        if (!cancelled) setError("Cannot reach the instrument server.");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const theme = useStore(app, (s) => s.theme);
  const selected = instruments.find((item) => item.id === selectedId) ?? instruments[0] ?? null;
  const where = selected ? coords(selected.latitude, selected.longitude) : null;

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-void">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="text-[11px] tracking-[0.16em] text-ink-dim">LIVE INSTRUMENT DATA</span>
        <div className="flex items-center gap-2">
          <ThemeToggle engine={engine} />
          <button
            onClick={onBack}
            className="flex h-9 items-center border border-line bg-panel px-3 text-[11px] tracking-wider text-ink-dim transition hover:border-line-strong hover:text-ink"
          >
            BACK
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="scroll-thin flex w-80 shrink-0 flex-col overflow-y-auto border-r border-line">
          <div className="label-xs px-4 py-3">Instruments</div>
          {error && <p className="px-4 pb-3 text-[11px] text-fire">{error}</p>}
          {!error && instruments.length === 0 && <p className="px-4 pb-3 text-[11px] text-ink-mute">Loading collectors…</p>}
          {instruments.map((item) => {
            const active = item.id === (selected?.id ?? null);
            const place = coords(item.latitude, item.longitude);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`border-t border-line px-4 py-3 text-left transition hover:bg-phos/5 ${active ? "bg-phos/10" : ""}`}
              >
                <div className="text-[12px] tracking-wide text-ink">{item.name}</div>
                <div className="mt-1 text-[11px] text-ink-dim">{item.location}</div>
                {place && <div className="mt-0.5 text-[10px] tracking-wide text-ink-mute">{place}</div>}
                <div className={`mt-2 text-[10px] tracking-[0.14em] ${item.reading.ok ? "text-phos" : "text-ink-mute"}`}>
                  {item.reading.label}
                  {item.reading.temperature_c != null && ` · ${item.reading.temperature_c.toFixed(1)}°C`}
                </div>
              </button>
            );
          })}
          <p className="mt-auto px-4 py-3 text-[10px] leading-relaxed text-ink-mute">
            Add another collector in wildfire/instruments.json with its name, location, and status URL.
          </p>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected && (
            <>
              <div className="border-b border-line px-4 py-3">
                <div className="text-[13px] tracking-wide text-ink">{selected.name}</div>
                <div className="mt-1 text-[11px] text-ink-dim">{selected.location}{where ? ` · ${where}` : ""}</div>
                <div className="mt-3 grid max-w-xl grid-cols-2 gap-x-6">
                  <KV k="SENSOR" v={selected.reading.label} accent={selected.reading.ok ? "var(--color-phos)" : undefined} />
                  <KV k="TEMP" v={metric(selected.reading.temperature_c, 1, "°C")} />
                  <KV k="HUMIDITY" v={metric(selected.reading.humidity_pct, 0, "%")} />
                  <KV k="WIND" v={metric(selected.reading.wind_mph, 1, " mph")} />
                  <KV k="FOSBERG" v={selected.reading.risk_score == null ? "—" : `${selected.reading.risk_score.toFixed(0)}${selected.reading.category ? ` ${selected.reading.category}` : ""}`} />
                  <KV k="COLLECTOR" v={selected.reading.endpoint ?? (selected.kind === "local" ? "This server" : "—")} />
                </div>
                {selected.reading.detail && <p className="mt-2 text-[11px] text-ink-mute">{selected.reading.detail}</p>}
              </div>
              {selected.dashboard ? (
                <iframe title={selected.name} src={dashboardUrl(selected.dashboard, theme)} className="min-h-0 w-full flex-1 border-0 bg-white" />
              ) : (
                <div className="px-4 py-6 text-[11px] leading-relaxed text-ink-mute">
                  {selected.kind === "demo"
                    ? "Simulated feed for this station. Temperature, humidity, wind, and the Fosberg score drift a little every few seconds."
                    : "This collector has no dashboard. Readings above are pulled from its status URL."}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
