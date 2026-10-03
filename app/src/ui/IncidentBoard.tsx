/**
 * Duty incident board: active fires with status, size, values at risk, last update.
 */
import { fireHotspotsOf } from "../state/fires";
import { useMemo, useState } from "react";
import {
  buildIncidents,
  INCIDENT_STATUS_LABEL,
  INCIDENT_STATUS_ORDER,
  loadIncidentOverrides,
  saveIncidentOverrides,
  type Incident,
  type IncidentStatus,
} from "../data/incidents";
import { assetsForRegions } from "../data/criticalAssets";
import { simulatedHotspots } from "../data/hazards";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices, useFocusRegions } from "./region";
import { Panel } from "./primitives";

function fmtArea(ha: number) {
  if (ha <= 0) return "—";
  if (ha >= 1000) return `${Math.round(ha / 1000)}k ha`;
  return `${Math.round(ha)} ha`;
}

function fmtWhen(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusColor(s: IncidentStatus) {
  if (s === "ia") return "var(--color-risk-ext)";
  if (s === "sustained") return "var(--color-fire)";
  if (s === "contained") return "var(--color-phos)";
  return "var(--color-risk-elev)";
}

function Row({
  inc,
  onStatus,
  onFly,
}: {
  inc: Incident;
  onStatus: (id: string, s: IncidentStatus) => void;
  onFly: () => void;
}) {
  return (
    <div className="border-b border-line/70 px-2.5 py-1.5 last:border-0">
      <div className="flex items-start gap-2">
        <button type="button" onClick={onFly} className="min-w-0 flex-1 text-left transition hover:text-phos">
          <div className="truncate text-[11px] font-medium text-ink">{inc.name}</div>
          <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-[9.5px] text-ink-mute">
            <span>{fmtArea(inc.areaHa)}</span>
            <span>· {inc.hotspotCount} hs</span>
            <span>· VAR {inc.valuesAtRisk}</span>
            <span>· {fmtWhen(inc.lastUpdate)}</span>
          </div>
        </button>
        <label className="shrink-0">
          <span className="sr-only">Status</span>
          <select
            value={inc.status}
            onChange={(e) => onStatus(inc.id, e.target.value as IncidentStatus)}
            className="max-w-[6.5rem] border border-line bg-transparent px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            style={{ color: statusColor(inc.status), borderColor: statusColor(inc.status) }}
            title={inc.override ? `Override (suggested ${INCIDENT_STATUS_LABEL[inc.suggested]})` : `Suggested ${INCIDENT_STATUS_LABEL[inc.suggested]}`}
          >
            {INCIDENT_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{INCIDENT_STATUS_LABEL[s]}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function IncidentBoard({ engine }: { engine: Engine | null }) {
  const perimeters = useStore(app, (s) => s.perimeters);
  // Heat that counts as fire (likely farm burns left out, reported fires added): state/fires.ts.
  const hotspots = useStore(app, fireHotspotsOf);
  const places = useStore(app, (s) => s.places);
  const weather = useStore(app, (s) => s.weather);
  const day = useStore(app, (s) => s.forecastDay);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const sim = useStore(app, (s) => s.simulation);
  const regions = useStore(app, (s) => s.regions);
  const focusIdx = useFocusIndices();
  const focusRegions = useFocusRegions();
  const [overrides, setOverrides] = useState(loadIncidentOverrides);

  const fires = useMemo(() => {
    return sim
      ? [...hotspots, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))]
      : hotspots.filter((h) => h.agency !== "SIMULATION");
  }, [sim, hotspots, regions]);

  const incidents = useMemo(() => {
    return buildIncidents({
      perimeters,
      hotspots: fires,
      places,
      weather,
      day,
      spread,
      growth,
      assets: assetsForRegions(focusRegions.map((r) => r.id)),
      overrides,
      focusRegions: focusIdx,
    });
  }, [perimeters, fires, places, weather, day, spread, growth, focusRegions, overrides, focusIdx]);

  const setStatus = (id: string, status: IncidentStatus) => {
    setOverrides((prev) => {
      const next = { ...prev, [id]: status };
      saveIncidentOverrides(next);
      return next;
    });
  };

  if (!incidents.length) {
    return (
      <Panel className="mt-2 w-[280px]" title="Incidents" tour="incidents">
        <div className="px-2.5 py-3 text-[11px] text-ink-mute">No active fires in focus.</div>
      </Panel>
    );
  }

  const open = incidents.filter((i) => i.status !== "contained").length;

  return (
    <Panel
      className="mt-2 w-[280px]"
      title="Incidents"
      tour="incidents"
      right={<span className="text-[9.5px] tabular-nums text-ink-mute">{open} open · {incidents.length}</span>}
    >
      <div className="scroll-thin max-h-[min(36vh,280px)] overflow-y-auto">
        {incidents.map((inc) => (
          <Row
            key={inc.id}
            inc={inc}
            onStatus={setStatus}
            onFly={() => engine?.flyToLatLng(inc.lat, inc.lng, 22)}
          />
        ))}
      </div>
      <div className="border-t border-line px-2.5 py-1 text-[9px] text-ink-mute">
        Status is local to this browser · IA / Sustained / Monitor / Contained
      </div>
    </Panel>
  );
}
