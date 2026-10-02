/** Explore panel: focus regions, browse every community, set label density. */
import { Crosshair, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { Engine } from "../engine";
import { app, type LabelMode } from "../state/app";
import { useStore } from "../state/store";
import { Panel } from "./primitives";
import { useFocusIndices } from "./region";

const LABEL_MODES: { mode: LabelMode; label: string; hint: string }[] = [
  { mode: "auto", label: "Auto", hint: "Major cities; smaller towns appear as you zoom in" },
  { mode: "all", label: "All", hint: "Every community" },
  { mode: "some", label: "Some", hint: "Towns ≥ 5,000" },
  { mode: "major", label: "Major", hint: "Cities ≥ 50,000" },
  { mode: "off", label: "Off", hint: "No labels" },
];

export function Explore({ engine }: { engine: Engine | null }) {
  const [tab, setTab] = useState<"regions" | "places">("regions");
  return (
    <Panel
      className="flex max-h-full w-[240px] flex-col"
      title="Explore"
      tour="explore"
      right={
        <div className="flex gap-1">
          {(["regions", "places"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-1.5 text-[10px] tracking-widest uppercase ${tab === t ? "text-phos" : "text-ink-mute hover:text-ink"}`}
            >
              {t}
            </button>
          ))}
        </div>
      }
    >
      {tab === "regions" ? <Regions engine={engine} /> : <Places engine={engine} />}
    </Panel>
  );
}

function Regions({ engine }: { engine: Engine | null }) {
  const regions = useStore(app, (s) => s.regions);
  const focus = useStore(app, (s) => s.focus);
  const loaded = useStore(app, (s) => s.loaded);
  return (
    <div className="py-1.5">
      {regions.map((r, i) => {
        const on = focus.includes(r.id);
        const ready = loaded.includes(r.id);
        return (
          <div key={r.id} className="flex items-center gap-2 px-3 py-1">
            <button
              disabled={!ready || (on && focus.length === 1)}
              onClick={() => engine?.toggleFocus(r.id)}
              title={on ? "Remove from focus" : "Add to focus"}
              className="flex flex-1 items-center gap-2.5 text-left text-[11px] disabled:cursor-default"
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center border" style={{ borderColor: on ? "var(--color-phos)" : "var(--color-ink-mute)" }}>
                {on && <span className="h-1.5 w-1.5 bg-phos" />}
              </span>
              <span className={on ? "text-ink" : "text-ink-mute"}>{r.name}</span>
              {!ready && <span className="animate-pulse text-[9.5px] text-ink-mute">loading</span>}
            </button>
            <button onClick={() => engine?.scene.flyToRegion(i)} disabled={!ready} title={`Fly to ${r.name}`} className="text-ink-mute hover:text-phos disabled:opacity-30">
              <Crosshair size={12} />
            </button>
          </div>
        );
      })}
      <div className="flex gap-1 border-t border-line px-3 pt-2 pb-1">
        <button onClick={() => engine?.setFocus(regions.filter((r) => loaded.includes(r.id)).map((r) => r.id))} className="flex-1 border border-line py-1 text-[10px] tracking-wide text-ink-dim hover:border-line-strong hover:text-ink">
          Focus all
        </button>
        <button onClick={() => { engine?.scene.resetView(); }} className="flex-1 border border-line py-1 text-[10px] tracking-wide text-ink-dim hover:border-line-strong hover:text-ink">
          Fit focus
        </button>
      </div>
      <p className="px-3 pt-1 pb-1.5 text-[10px] leading-snug text-ink-mute">Click a greyed province on the map to bring it into focus.</p>
    </div>
  );
}

function Places({ engine }: { engine: Engine | null }) {
  const places = useStore(app, (s) => s.places);
  const regions = useStore(app, (s) => s.regions);
  const mode = useStore(app, (s) => s.labelMode);
  const focus = useFocusIndices();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return places
      // Focused provinces only, like the map labels; a search also finds places elsewhere.
      .filter((p) => focus.has(p.region) || needle)
      .filter((p) => !p.landmark || needle)
      .filter((p) => !needle || p.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(focus.has(b.region)) - Number(focus.has(a.region)) || b.pop - a.pop);
  }, [places, q, focus]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-3 pt-2">
        <div className="label-xs mb-1">Map labels</div>
        <div className="grid grid-cols-5 border border-line">
          {LABEL_MODES.map((m) => (
            <button
              key={m.mode}
              title={m.hint}
              onClick={() => engine?.setLabelMode(m.mode)}
              className={`py-1 text-[10px] tracking-wider ${mode === m.mode ? "bg-phos/15 text-phos" : "text-ink-mute hover:text-ink"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <label className="mx-3 mt-2 flex items-center gap-2 border border-line px-2 py-1">
        <Search size={12} className="text-ink-mute" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search places (all provinces)"
          className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-mute"
        />
      </label>
      <ul className="scroll-thin mt-1.5 min-h-0 flex-1 overflow-y-auto pb-1.5" style={{ maxHeight: 320 }}>
        {list.map((p) => (
          <li key={`${p.region}:${p.name}:${p.lat}`}>
            <button
              onClick={() => engine?.flyToLatLng(p.lat, p.lng, p.landmark ? 6 : p.pop > 200_000 ? 45 : 18)}
              className={`flex w-full items-baseline justify-between gap-2 px-3 py-1 text-left text-[11px] hover:bg-phos/5 ${focus.has(p.region) ? "text-ink" : "text-ink-mute"}`}
            >
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-[9.5px] tabular-nums text-ink-mute">
                {p.landmark ? "landmark" : `${regions[p.region]?.code} · ${p.pop >= 1000 ? `${Math.round(p.pop / 1000)}k` : p.pop}`}
              </span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="px-3 py-2 text-[11px] text-ink-mute">No matches.</li>}
      </ul>
    </div>
  );
}
