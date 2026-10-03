/**
 * Duty checklist: schools, hospitals, industrial sites, and power near the
 * fire closest to the selected hex. Check off notify / evacuate / clear.
 */
import { useEffect, useMemo, useState } from "react";
import { Building2, Check, Factory, Hospital, School, Zap } from "lucide-react";
import { ASSET_KIND_ORDER, ASSET_LABEL, assetsForRegions, type AssetKind } from "../data/criticalAssets";
import { simulatedHotspots } from "../data/hazards";
import { valuesAtRisk, type ValueAtRisk } from "../data/valuesAtRisk";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusRegions } from "./region";
import { Panel } from "./primitives";

type CheckState = "open" | "notified" | "evac" | "clear";

const CHECK_CYCLE: CheckState[] = ["open", "notified", "evac", "clear"];
const CHECK_LABEL: Record<CheckState, string> = {
  open: "Open",
  notified: "Notified",
  evac: "Evacuate",
  clear: "Clear",
};
const STORAGE_KEY = "firewatch.var.checks";

const KIND_ICON: Record<AssetKind, typeof Hospital> = {
  hospital: Hospital,
  school: School,
  industrial: Factory,
  power: Zap,
};

function loadChecks(): Record<string, CheckState> {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function scoreColor(score: number) {
  if (score >= 0.75) return "var(--color-risk-ext)";
  if (score >= 0.5) return "var(--color-risk-high)";
  if (score >= 0.3) return "var(--color-risk-elev)";
  return "var(--color-ink-dim)";
}

function ItemRow({
  item,
  state,
  onCycle,
  onFly,
}: {
  item: ValueAtRisk;
  state: CheckState;
  onCycle: () => void;
  onFly: () => void;
}) {
  const Icon = KIND_ICON[item.asset.kind] ?? Building2;
  const done = state === "clear" || state === "evac";
  return (
    <div className={`flex items-start gap-2 border-b border-line/70 px-2.5 py-1.5 last:border-0 ${done ? "opacity-55" : ""}`}>
      <button
        type="button"
        onClick={onCycle}
        title={`Mark ${CHECK_LABEL[state]} → next`}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-[9px]"
        style={{
          borderColor: state === "open" ? "var(--color-line)" : scoreColor(item.score),
          color: state === "open" ? "var(--color-ink-mute)" : scoreColor(item.score),
        }}
        aria-label={`${item.asset.name}: ${CHECK_LABEL[state]}`}
      >
        {state === "clear" ? <Check size={11} /> : state === "open" ? null : state[0].toUpperCase()}
      </button>
      <button type="button" onClick={onFly} className="min-w-0 flex-1 text-left transition hover:text-phos">
        <div className="flex items-center gap-1.5 text-[11px] text-ink">
          <Icon size={11} className="shrink-0 text-ink-mute" />
          <span className="truncate font-medium">{item.asset.name}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[9.5px] text-ink-mute">
          <span className="uppercase tracking-wide">{ASSET_LABEL[item.asset.kind]}</span>
          <span style={{ color: scoreColor(item.score) }}>· {item.reason}</span>
          {item.asset.note && <span className="truncate">· {item.asset.note}</span>}
        </div>
      </button>
      <span className="shrink-0 pt-0.5 text-[9px] tabular-nums text-ink-mute">{CHECK_LABEL[state]}</span>
    </div>
  );
}

export function ValuesAtRisk({ engine }: { engine: Engine | null }) {
  const selected = useStore(app, (s) => s.selected);
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const weather = useStore(app, (s) => s.weather);
  const day = useStore(app, (s) => s.forecastDay);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const sim = useStore(app, (s) => s.simulation);
  const regions = useFocusRegions();

  const [checks, setChecks] = useState<Record<string, CheckState>>(loadChecks);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(checks)); } catch { /* ignore */ }
  }, [checks]);

  const result = useMemo(() => {
    if (!selected) return null;
    const assets = assetsForRegions(regions.map((r) => r.id));
    if (!assets.length) return null;
    const fires = sim
      ? [...hotspots, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))]
      : hotspots.filter((h) => h.agency !== "SIMULATION");
    return valuesAtRisk({
      lat: selected.lat,
      lng: selected.lng,
      assets,
      hotspots: fires,
      perimeters,
      weather,
      day,
      spread,
      growth,
    });
  }, [selected, regions, hotspots, perimeters, weather, day, spread, growth, sim]);

  if (!selected || !result) return null;
  const { focus, items } = result;

  const cycle = (id: string) => {
    setChecks((prev) => {
      const cur = prev[id] ?? "open";
      const next = CHECK_CYCLE[(CHECK_CYCLE.indexOf(cur) + 1) % CHECK_CYCLE.length];
      return { ...prev, [id]: next };
    });
  };

  const byKind = ASSET_KIND_ORDER.map((kind) => ({
    kind,
    rows: items.filter((i) => i.asset.kind === kind),
  })).filter((g) => g.rows.length);

  const openCount = items.filter((i) => (checks[i.asset.id] ?? "open") === "open").length;

  return (
    <Panel
      className="mt-2 w-[280px]"
      title="Values at risk"
      tour="values-at-risk"
      right={
        <span className="text-[9.5px] tabular-nums text-ink-mute">
          {items.length ? `${openCount}/${items.length} open` : "none"}
        </span>
      }
    >
      <div className="border-b border-line px-2.5 py-1.5 text-[10px] text-ink-mute">
        Near <span className="text-ink-dim">{focus.label}</span>
        {focus.label !== "this sector" ? " · fire closest to selection" : " · no nearby fire"}
      </div>
      {items.length === 0 ? (
        <div className="px-2.5 py-3 text-[11px] text-ink-mute">No schools, hospitals, industry, or power within 40 km.</div>
      ) : (
        <div className="scroll-thin max-h-[min(42vh,320px)] overflow-y-auto">
          {byKind.map(({ kind, rows }) => (
            <div key={kind}>
              <div className="sticky top-0 z-[1] bg-panel/95 px-2.5 py-1 text-[9px] font-bold tracking-[0.08em] uppercase text-ink-mute backdrop-blur-sm">
                {ASSET_LABEL[kind]} · {rows.length}
              </div>
              {rows.map((item) => (
                <ItemRow
                  key={item.asset.id}
                  item={item}
                  state={checks[item.asset.id] ?? "open"}
                  onCycle={() => cycle(item.asset.id)}
                  onFly={() => engine?.flyToLatLng(item.asset.lat, item.asset.lng, 18)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-line px-2.5 py-1 text-[9px] text-ink-mute">
        Tap status: Open → Notified → Evacuate → Clear · planning aid only
      </div>
    </Panel>
  );
}
