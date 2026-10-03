/** North bar: agency title, data status, screen options. */
import { Moon, Radio, Sun } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Engine } from "../engine";
import { useStore } from "../state/store";
import { app } from "../state/app";
import { LogoMark } from "./primitives";
import { useFocusRegions } from "./region";

function Dot({ state }: { state: "loading" | "ok" | "error" }) {
  const c = state === "ok" ? "var(--color-phos-glow)" : state === "error" ? "var(--color-fire)" : "var(--color-risk-elev)";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${state === "loading" ? "animate-pulse" : ""}`} style={{ background: c }} />;
}

export function Brand() {
  const ds = useStore(app, (s) => s.dataStatus);
  const sim = useStore(app, (s) => s.simulation);
  const focused = useFocusRegions();
  const title = focused.length === 1 ? focused[0].name : focused.map((r) => r.code).join(" · ");
  const at = ds.at ? new Date(ds.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--";
  return (
    <div className="pointer-events-auto flex items-center gap-3" data-tour="brand">
      <LogoMark />
      <div>
        <div className="text-[15px] font-bold tracking-[0.12em] text-ink">
          FIRE<span className="text-phos">//</span>WATCH
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tracking-[0.08em] text-ink-mute">
          <span>North · {title} wildfire situation</span>
          <span className="flex items-center gap-1.5"><Dot state={ds.cwfis} />CWFIS</span>
          <span className="flex items-center gap-1.5"><Dot state={ds.weather} />Weather</span>
          <span className="hidden sm:inline">Updated {at}</span>
          {sim && (
            <span className="flex items-center gap-1 border border-risk-high px-1.5 text-risk-high">
              <Radio size={10} /> Simulation
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function BarButton({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pointer-events-auto flex h-9 items-center border px-3 text-[11px] tracking-wide transition ${active ? "border-white/50 bg-white/10 text-white" : "border-white/20 bg-transparent text-white/80 hover:border-white/40 hover:text-white"}`}
    >
      {children}
    </button>
  );
}

export function AppBar({
  engine,
  screen,
  onScreen,
  center,
  extra,
  askOpen,
  onAsk,
}: {
  engine: Engine | null;
  screen: "map" | "instruments";
  onScreen: (screen: "map" | "instruments") => void;
  center?: ReactNode;
  extra?: ReactNode;
  askOpen?: boolean;
  onAsk?: () => void;
}) {
  return (
    <div className="app-chrome pointer-events-auto flex w-full items-center justify-between gap-4 px-4 py-2.5">
      <Brand />
      <div className="flex min-w-0 flex-1 justify-center">{center}</div>
      <div className="flex shrink-0 items-center gap-2">
        <BarButton active={screen === "map"} onClick={() => onScreen("map")}>Map</BarButton>
        <BarButton active={screen === "instruments"} onClick={() => onScreen("instruments")}>Live instrument data</BarButton>
        {onAsk && <BarButton active={askOpen} onClick={onAsk}>Ask</BarButton>}
        {extra}
        <ThemeToggle engine={engine} />
      </div>
    </div>
  );
}

export function ThemeToggle({ engine }: { engine: Engine | null }) {
  const theme = useStore(app, (s) => s.theme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      onClick={() => engine?.setTheme(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className="pointer-events-auto flex h-9 items-center gap-2 border border-white/20 px-3 text-[11px] tracking-wide text-white/80 transition hover:border-white/40 hover:text-white"
    >
      {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      <span className="hidden sm:inline">{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}

const fmtKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km >= 10 ? Math.round(km) : +km.toFixed(1)} km`);

/** Longest round distance (1 / 2 / 5 × 10ⁿ km) that fits in `maxPx` at this zoom. */
function niceScale(kmPerPx: number, maxPx: number) {
  const max = kmPerPx * maxPx;
  const p = 10 ** Math.floor(Math.log10(max));
  const km = [5, 2, 1].map((m) => m * p).find((v) => v <= max) ?? p;
  return { km, px: km / kmPerPx };
}

/**
 * Map scale bar (how long a distance is on screen at the centre of the view, updated every frame
 * as you zoom) and the cell size.
 */
export function LodReadout({ engine }: { engine: Engine | null }) {
  const s = useStore(app, (a) => a.stats);
  const bar = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0, lastPx = -1, lastKm = -1;
    const tick = () => {
      const kmPerPx = engine?.scene?.kmPerPx;
      if (kmPerPx && Number.isFinite(kmPerPx) && kmPerPx > 0) {
        const { km, px } = niceScale(kmPerPx, 110);
        if (bar.current && Math.abs(px - lastPx) > 0.25) { lastPx = px; bar.current.style.width = `${px.toFixed(1)}px`; }
        if (label.current && km !== lastKm) { lastKm = km; label.current.textContent = fmtKm(km); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);
  if (!s) return null;
  const cellKm = s.hexSizeKm * Math.sqrt(3);
  return (
    <div data-tour="lod" className="pointer-events-none hidden items-center gap-4 text-[10px] tracking-[0.08em] text-ink-mute md:flex">
      <span className="flex items-center gap-2" title="Map scale at the centre of the view">
        <span ref={bar} className="inline-block h-[7px] border-x border-b border-current text-ink-dim" style={{ width: 0 }} aria-hidden />
        <span ref={label} className="tabular-nums text-ink-dim" />
      </span>
      <span title="Width of one hex cell at this zoom">Hex {fmtKm(cellKm)}</span>
      <span className="hidden lg:inline">{s.hexes.toLocaleString()} cells</span>
    </div>
  );
}
