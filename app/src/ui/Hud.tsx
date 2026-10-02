/** Top bar: logo on the left, screen options on the right, map readout in the middle. */
import { Moon, Radio, Sun } from "lucide-react";
import type { ReactNode } from "react";
import type { Engine } from "../engine";
import { useStore } from "../state/store";
import { app } from "../state/app";
import { HexIcon } from "./primitives";
import { useFocusRegions } from "./region";

function Dot({ state }: { state: "loading" | "ok" | "error" }) {
  const c = state === "ok" ? "var(--color-phos)" : state === "error" ? "var(--color-fire)" : "var(--color-risk-elev)";
  return <span className={`inline-block h-1.5 w-1.5 ${state === "loading" ? "animate-pulse" : ""}`} style={{ background: c, boxShadow: `0 0 6px ${c}` }} />;
}

export function Brand() {
  const ds = useStore(app, (s) => s.dataStatus);
  const sim = useStore(app, (s) => s.simulation);
  const focused = useFocusRegions();
  const title = focused.length === 1 ? focused[0].name.toUpperCase() : focused.map((r) => r.code).join(" · ");
  const at = ds.at ? new Date(ds.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--";
  return (
    <div className="pointer-events-auto flex items-center gap-3" data-tour="brand">
      <div className="relative">
        <HexIcon size={34} color="var(--color-phos)" className="drop-shadow-[0_0_8px_rgba(46,234,124,.6)]" />
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-phos-glow">E</span>
      </div>
      <div>
        <div className="text-[15px] font-bold tracking-[0.22em] text-ink glow-text">
          EMBER<span className="text-phos">//</span>WATCH
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-[10px] tracking-[0.14em] text-ink-mute">
          <span>{title} WILDFIRE INTEL</span>
          <span className="flex items-center gap-1.5"><Dot state={ds.cwfis} />CWFIS</span>
          <span className="flex items-center gap-1.5"><Dot state={ds.weather} />WX</span>
          <span className="hidden sm:inline">SYNC {at}</span>
          {sim && (
            <span className="flex items-center gap-1 border border-risk-high px-1.5 text-risk-high">
              <Radio size={10} /> SIMULATION
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
      className={`pointer-events-auto flex h-9 items-center border bg-panel px-3 text-[11px] tracking-wider transition ${active ? "border-phos text-phos" : "border-line text-ink-dim hover:border-line-strong hover:text-ink"}`}
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
}: {
  engine: Engine | null;
  screen: "map" | "instruments";
  onScreen: (screen: "map" | "instruments") => void;
  center?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className={`pointer-events-auto flex w-full items-center justify-between gap-4 px-4 py-2 ${screen === "map" ? "" : "border-b border-line bg-void"}`}>
      <Brand />
      <div className="flex min-w-0 flex-1 justify-center">{center}</div>
      <div className="flex shrink-0 items-center gap-2">
        <BarButton active={screen === "map"} onClick={() => onScreen("map")}>MAP</BarButton>
        <BarButton active={screen === "instruments"} onClick={() => onScreen("instruments")}>LIVE INSTRUMENT DATA</BarButton>
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
      className="pointer-events-auto flex h-9 items-center gap-2 border border-line bg-panel px-3 text-[11px] tracking-wider text-ink-dim transition hover:border-line-strong hover:text-ink"
    >
      {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      <span className="hidden sm:inline">{theme === "dark" ? "LIGHT" : "DARK"}</span>
    </button>
  );
}

export function LodReadout() {
  const s = useStore(app, (a) => a.stats);
  if (!s) return null;
  const km = s.hexSizeKm * Math.sqrt(3);
  return (
    <div data-tour="lod" className="pointer-events-none hidden items-center gap-4 border border-line bg-panel px-3 py-1.5 text-[10px] tracking-[0.14em] text-ink-dim md:flex">
      <span><span className="text-ink-mute">LOD</span> <span className="text-phos">{s.level}</span></span>
      <span><span className="text-ink-mute">CELL</span> {km < 1 ? `${Math.round(km * 1000)} M` : `${km.toFixed(1)} KM`}</span>
      <span><span className="text-ink-mute">NODES</span> {s.hexes.toLocaleString()}</span>
      <span><span className="text-ink-mute">ALT</span> {Math.round(s.dist)} KM</span>
      <span><span className="text-ink-mute">Z×</span>{s.vScale.toFixed(1)}</span>
      <span className={s.fps < 40 ? "text-risk-high" : ""}><span className="text-ink-mute">FPS</span> {Math.round(s.fps)}</span>
      {s.pending > 0 && <span className="animate-pulse text-phos">STREAMING</span>}
    </div>
  );
}
