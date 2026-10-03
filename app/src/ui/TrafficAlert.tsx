/**
 * Highway corridors with a fire near them, worst first. Compact HUD strip.
 */
import { AlertTriangle, Truck } from "lucide-react";
import { FREIGHT_SHARE } from "../data/trafficRisk";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";

const MAX_SHOWN = 3;
const AMBER = "#b8791f";

const fmtVolume = (v: number) => (Math.round(v / (v >= 10_000 ? 100 : 10)) * (v >= 10_000 ? 100 : 10)).toLocaleString();

export function TrafficAlert({ engine }: { engine: Engine | null }) {
  const on = useStore(app, (s) => s.layers.traffic);
  const atRisk = useStore(app, (s) => s.trafficThreats);
  const sim = useStore(app, (s) => s.simulation);

  if (!on || !atRisk.length) return null;
  const closed = atRisk.filter((t) => t.closed).length;
  return (
    <div
      className="panel hud-strip pointer-events-auto flex items-center"
      style={{ borderColor: `${AMBER}55` }}
      title={sim ? "Evacuation + closures simulated" : undefined}
    >
      <span className="label-xs flex shrink-0 items-center gap-1" style={{ color: AMBER }}>
        <Truck size={10} />
        Roads
        {closed > 0 && <span className="text-risk-ext">·{closed}×</span>}
      </span>
      <div className="scroll-thin flex min-w-0 gap-1 overflow-x-auto">
        {atRisk.slice(0, MAX_SHOWN).map((t) => (
          <button
            key={`${t.region}-${t.highway.n}-${t.highway.cls}`}
            onClick={() => engine?.flyToLatLng(t.lat, t.lng, 25)}
            title={[
              `Hwy ${t.highway.n} · ${t.reason} · threat ${Math.round(t.score * 100)}`,
              `${fmtVolume(t.volume)} vehicles/day`,
              t.closed ? "Closed by fire in this scenario" : "",
            ].filter(Boolean).join("\n")}
            className="hud-chip shrink-0"
            style={{ borderColor: t.closed ? "var(--color-risk-ext)" : `${AMBER}55` }}
          >
            Hwy {t.highway.n}
            {t.closed ? (
              <span className="text-risk-ext"> · CLOSED</span>
            ) : (
              <span className="text-ink-mute"> · {fmtVolume(t.volume)}</span>
            )}
            {t.jam >= 0.25 && !t.closed && <AlertTriangle size={8} className="ml-0.5 inline align-[-1px]" style={{ color: AMBER }} />}
            {t.highway.commercial >= FREIGHT_SHARE && <Truck size={8} className="ml-0.5 inline align-[-1px]" style={{ color: AMBER }} />}
            <span className={t.score >= 0.6 ? "text-risk-ext" : "text-risk-high"}> · {t.reason}</span>
          </button>
        ))}
        {atRisk.length > MAX_SHOWN && (
          <span className="shrink-0 self-center text-[9px] text-ink-mute">+{atRisk.length - MAX_SHOWN}</span>
        )}
      </div>
    </div>
  );
}
