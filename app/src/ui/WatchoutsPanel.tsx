/**
 * Duty watchouts: set FWI / path / RH triggers and see which are firing.
 */
import { useEffect, useMemo, useState } from "react";
import { Bell, Plus, Trash2 } from "lucide-react";
import {
  defaultWatchouts,
  evaluateWatchouts,
  loadWatchouts,
  newWatchoutId,
  saveWatchouts,
  type Watchout,
  type WatchoutKind,
} from "../data/watchouts";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { Panel } from "./primitives";

const KINDS: { kind: WatchoutKind; label: string }[] = [
  { kind: "fwi_above", label: "FWI ≥" },
  { kind: "path_reaches", label: "Path reaches" },
  { kind: "rh_below_by", label: "RH ≤ by hour" },
];

function blank(kind: WatchoutKind): Watchout {
  if (kind === "fwi_above") return { id: newWatchoutId(), kind, enabled: true, place: "", fwi: 20 };
  if (kind === "rh_below_by") return { id: newWatchoutId(), kind, enabled: true, place: "", rh: 25, hour: 14 };
  return { id: newWatchoutId(), kind, enabled: true, place: "" };
}

export function WatchoutsPanel({ engine }: { engine: Engine | null }) {
  const places = useStore(app, (s) => s.places);
  const weather = useStore(app, (s) => s.weather);
  const day = useStore(app, (s) => s.forecastDay);
  const spread = useStore(app, (s) => s.spread);
  const focus = useFocusIndices();
  const [list, setList] = useState<Watchout[]>(() => {
    const loaded = loadWatchouts();
    return loaded.length ? loaded : defaultWatchouts();
  });
  const [addKind, setAddKind] = useState<WatchoutKind>("path_reaches");

  useEffect(() => { saveWatchouts(list); }, [list]);

  const hits = useMemo(
    () => evaluateWatchouts({ watchouts: list, places, weather, day, spread, focusRegions: focus }),
    [list, places, weather, day, spread, focus],
  );

  const update = (id: string, patch: Partial<Watchout>) => {
    setList((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  };
  const remove = (id: string) => setList((prev) => prev.filter((w) => w.id !== id));
  const add = () => setList((prev) => [...prev, blank(addKind)]);

  return (
    <Panel
      className="mt-2 w-[280px]"
      title="Watchouts"
      tour="watchouts"
      right={
        <span className="flex items-center gap-1 text-[9.5px] tabular-nums text-ink-mute">
          {hits.length > 0 && <Bell size={10} className="text-risk-high" />}
          {hits.length} firing
        </span>
      }
    >
      {hits.length > 0 && (
        <div className="border-b border-line px-2 py-1.5">
          <div className="label-xs mb-1 text-risk-high">Firing now</div>
          <div className="flex flex-col gap-0.5">
            {hits.slice(0, 6).map((h) => (
              <button
                key={h.key}
                type="button"
                onClick={() => engine?.flyToLatLng(h.lat, h.lng, 25)}
                className="truncate text-left text-[10.5px] text-risk-high transition hover:underline"
              >
                {h.text}
              </button>
            ))}
            {hits.length > 6 && <span className="text-[9px] text-ink-mute">+{hits.length - 6} more</span>}
          </div>
        </div>
      )}

      <div className="scroll-thin max-h-[min(32vh,240px)] overflow-y-auto">
        {list.map((w) => (
          <div key={w.id} className="flex items-start gap-1.5 border-b border-line/70 px-2 py-1.5 last:border-0">
            <input
              type="checkbox"
              checked={w.enabled}
              onChange={(e) => update(w.id, { enabled: e.target.checked })}
              className="mt-1"
              title="Enabled"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-wide text-ink-mute">
                {KINDS.find((k) => k.kind === w.kind)?.label ?? w.kind}
              </div>
              {w.kind === "fwi_above" && (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={w.fwi ?? 20}
                    min={1}
                    max={60}
                    onChange={(e) => update(w.id, { fwi: Number(e.target.value) })}
                    className="w-12 border border-line bg-transparent px-1 py-0.5 text-[11px] tabular-nums"
                  />
                  <input
                    value={w.place}
                    onChange={(e) => update(w.id, { place: e.target.value })}
                    placeholder="Any focus town"
                    className="min-w-0 flex-1 border border-line bg-transparent px-1 py-0.5 text-[11px]"
                  />
                </div>
              )}
              {w.kind === "path_reaches" && (
                <input
                  value={w.place}
                  onChange={(e) => update(w.id, { place: e.target.value })}
                  placeholder="Town name"
                  className="w-full border border-line bg-transparent px-1 py-0.5 text-[11px]"
                />
              )}
              {w.kind === "rh_below_by" && (
                <div className="flex flex-wrap items-center gap-1">
                  <input
                    type="number"
                    value={w.rh ?? 25}
                    min={1}
                    max={100}
                    onChange={(e) => update(w.id, { rh: Number(e.target.value) })}
                    className="w-12 border border-line bg-transparent px-1 py-0.5 text-[11px] tabular-nums"
                    title="RH %"
                  />
                  <span className="text-[9px] text-ink-mute">% by</span>
                  <input
                    type="number"
                    value={w.hour ?? 14}
                    min={0}
                    max={23}
                    onChange={(e) => update(w.id, { hour: Number(e.target.value) })}
                    className="w-10 border border-line bg-transparent px-1 py-0.5 text-[11px] tabular-nums"
                    title="Hour"
                  />
                  <span className="text-[9px] text-ink-mute">:00</span>
                  <input
                    value={w.place}
                    onChange={(e) => update(w.id, { place: e.target.value })}
                    placeholder="Any focus town"
                    className="min-w-0 flex-1 border border-line bg-transparent px-1 py-0.5 text-[11px]"
                  />
                </div>
              )}
            </div>
            <button type="button" onClick={() => remove(w.id)} className="mt-0.5 text-ink-mute hover:text-risk-high" aria-label="Remove">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
        <select
          value={addKind}
          onChange={(e) => setAddKind(e.target.value as WatchoutKind)}
          className="min-w-0 flex-1 border border-line bg-transparent px-1 py-0.5 text-[10px]"
        >
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>{k.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 border border-line px-2 py-0.5 text-[10px] text-ink-dim transition hover:border-phos hover:text-phos"
        >
          <Plus size={11} /> Add
        </button>
      </div>
    </Panel>
  );
}
