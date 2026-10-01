/**
 * LOD tuner — dev overlay for the hex world's zoom behaviour.
 *
 *   Ctrl+Shift+L (dev builds, or any page opened once with ?fireflydev)
 *
 * Live-edits: the camera distance at which each grid level takes over, switch
 * hysteresis, render distance, and vertical exaggeration. Tweaks persist in
 * localStorage (applied on load) until you Copy config → paste into config/grid.ts
 * and Reset.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { GRID, VSCALE, verticalScale } from "../config/grid";
import { isFireflyDevEnabled } from "../mascot/firefly/script";
import { app } from "../state/app";
import { useStore } from "../state/store";

const KEY = "embergrid.lodTuning";

interface Tuning {
  minDist: number[];
  hysteresis: number;
  viewRadiusFactor: number;
  maxRadiusHexes: number;
  vscale: typeof VSCALE;
}

/** Defaults as shipped in config/grid.ts (captured before any saved tuning is applied). */
const DEFAULTS: Tuning = snapshot();

function snapshot(): Tuning {
  return {
    minDist: GRID.levels.map((l) => l.minDist),
    hysteresis: GRID.hysteresis,
    viewRadiusFactor: GRID.viewRadiusFactor,
    maxRadiusHexes: GRID.maxRadiusHexes,
    vscale: { ...VSCALE },
  };
}

function apply(t: Tuning) {
  t.minDist.forEach((d, i) => { if (GRID.levels[i]) GRID.levels[i].minDist = d; });
  GRID.hysteresis = t.hysteresis;
  GRID.viewRadiusFactor = t.viewRadiusFactor;
  GRID.maxRadiusHexes = t.maxRadiusHexes;
  Object.assign(VSCALE, t.vscale);
}

/** Apply saved tuning (call before the engine boots). */
export function applySavedLodTuning() {
  if (!isFireflyDevEnabled()) return;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Tuning | null;
    if (saved && saved.minDist?.length === GRID.levels.length) apply(saved);
  } catch { /* ignore */ }
}

let mounted = false;
export function mountLodTuner(engine: () => { scene: { zoomBy: (f: number) => void; distance: number } } | null) {
  if (mounted || !isFireflyDevEnabled()) return;
  mounted = true;
  const host = document.createElement("div");
  host.setAttribute("data-firefly-ui", "lod");
  Object.assign(host.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483002" });
  document.body.appendChild(host);
  createRoot(host).render(<LodTuner engine={engine} />);
}

function LodTuner({ engine }: { engine: () => { scene: { zoomBy: (f: number) => void; distance: number } } | null }) {
  const [open, setOpen] = useState(false);
  const [t, setT] = useState<Tuning>(snapshot);
  const [toast, setToast] = useState("");
  const stats = useStore(app, (s) => s.stats);
  const pos = useDrag("embergrid.lodTuner.pos", { x: 360, y: 60 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); setOpen((o) => !o); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const update = (next: Tuning) => {
    // Keep thresholds strictly descending, last level always 0.
    const md = [...next.minDist];
    md[md.length - 1] = 0;
    for (let i = md.length - 2; i >= 0; i--) md[i] = Math.max(md[i], md[i + 1] + 1);
    const fixed = { ...next, minDist: md };
    setT(fixed);
    apply(fixed);
    try { localStorage.setItem(KEY, JSON.stringify(fixed)); } catch { /* ignore */ }
  };

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 1600); };
  const goTo = (dist: number) => {
    const e = engine();
    if (e) e.scene.zoomBy(Math.max(3, dist) / e.scene.distance);
  };

  const copy = async () => {
    const lv = GRID.levels.map((l) => `    { size: ${l.size}, minDist: ${l.minDist}, terrace: ${l.terrace}, majorityLandClass: ${l.majorityLandClass}, decorations: ${l.decorations}, buildingMinHeight: ${l.buildingMinHeight === Infinity ? "Infinity" : l.buildingMinHeight}, landmarks: ${l.landmarks} },`).join("\n");
    const text = `// config/grid.ts — tuned with the LOD tuner
// GRID fields:
  viewRadiusFactor: ${t.viewRadiusFactor},
  maxRadiusHexes: ${t.maxRadiusHexes},
  hysteresis: ${t.hysteresis},
  levels: [
${lv}
  ] satisfies GridLevel[],

export const VSCALE = ${JSON.stringify(t.vscale).replace(/"(\w+)":/g, "$1: ").replace(/,/g, ", ")};
`;
    await navigator.clipboard.writeText(text);
    flash("Config copied");
  };

  const reset = () => {
    update(structuredClone(DEFAULTS));
    localStorage.removeItem(KEY);
    flash("Reset to config/grid.ts defaults");
  };

  if (!open) return null;
  const dist = stats?.dist ?? 0;
  const active = stats?.level ?? -1;
  const vs = t.vscale;

  return (
    <div ref={pos.ref} data-firefly-ui style={{ ...S.panel, left: pos.pos.x, top: pos.pos.y }}>
      <div style={{ ...S.head, cursor: "grab" }} onPointerDown={pos.onPointerDown}>
        <b style={{ letterSpacing: ".16em", userSelect: "none" }}>⠿ LOD TUNER</b>
        <button style={S.x} onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)}>✕</button>
      </div>
      <div style={S.live}>
        camera <b>{Math.round(dist)} km</b> · level <b>{active}</b> · cell <b>{stats ? (stats.hexSizeKm * Math.sqrt(3)).toFixed(2) : "–"} km</b> · ×<b>{verticalScale(dist).toFixed(1)}</b>
      </div>

      <Label>Level switch distances (camera km)</Label>
      {GRID.levels.map((l, i) => {
        const last = i === GRID.levels.length - 1;
        return (
          <div key={i} style={{ ...S.row, ...(i === active ? S.rowOn : {}) }}>
            <span style={{ width: 92 }}>L{i} · {(l.size * Math.sqrt(3)).toFixed(l.size < 1 ? 2 : 0)} km</span>
            {last ? (
              <span style={{ flex: 1, color: "#5d7f90" }}>finest (always below L{i - 1})</span>
            ) : (
              <>
                <span style={{ color: "#5d7f90" }}>≥</span>
                <input type="number" min={1} value={t.minDist[i]} onChange={(e) => update({ ...t, minDist: t.minDist.map((d, j) => (j === i ? +e.target.value : d)) })} style={{ ...S.input, width: 70 }} />
                <input type="range" min={Math.log(2)} max={Math.log(8000)} step={0.01} value={Math.log(Math.max(2, t.minDist[i]))}
                  onChange={(e) => update({ ...t, minDist: t.minDist.map((d, j) => (j === i ? Math.round(Math.exp(+e.target.value)) : d)) })} style={{ flex: 1 }} />
              </>
            )}
            <button style={S.btn} title="Fly the camera to this level's switch distance" onClick={() => goTo(last ? t.minDist[i - 1] * 0.5 : t.minDist[i] * 1.02)}>go</button>
          </div>
        );
      })}
      <Slider label="Switch hysteresis" value={t.hysteresis} min={0} max={0.3} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} set={(v) => update({ ...t, hysteresis: v })} />

      <Label>Render distance</Label>
      <Slider label="View radius (× camera distance)" value={t.viewRadiusFactor} min={0.5} max={4} step={0.05} fmt={(v) => v.toFixed(2)} set={(v) => update({ ...t, viewRadiusFactor: v })} />
      <Slider label="Max radius (hexes of the active level)" value={t.maxRadiusHexes} min={20} max={300} step={5} fmt={(v) => `${v}`} set={(v) => update({ ...t, maxRadiusHexes: v })} />
      <div style={S.note}>
        Now drawing {stats?.hexes?.toLocaleString() ?? "–"} hexes in {stats?.chunks ?? "–"} chunks · {Math.round(stats?.fps ?? 0)} fps
      </div>

      <Label>Height exaggeration</Label>
      <Slider label="Close up" value={vs.close} min={1} max={20} step={0.5} fmt={(v) => `×${v}`} set={(v) => update({ ...t, vscale: { ...vs, close: v } })} />
      <Slider label={`Province view (at ${vs.provinceDist} km)`} value={vs.province} min={5} max={120} step={1} fmt={(v) => `×${v}`} set={(v) => update({ ...t, vscale: { ...vs, province: v } })} />
      <Slider label={`National view (at ${vs.nationalDist} km)`} value={vs.national} min={5} max={200} step={1} fmt={(v) => `×${v}`} set={(v) => update({ ...t, vscale: { ...vs, national: v } })} />
      <Slider label="Ramp curve (higher = later)" value={vs.curve} min={0.5} max={6} step={0.1} fmt={(v) => v.toFixed(1)} set={(v) => update({ ...t, vscale: { ...vs, curve: v } })} />

      <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
        <button style={S.btn} onClick={copy}>Copy config</button>
        <button style={S.btn} onClick={reset}>Reset</button>
      </div>
      <div style={S.note}>Changes apply live and persist on this browser until Reset. Paste the copied config into <code>src/config/grid.ts</code> to make it permanent.</div>
      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- bits
function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "#5d7f90", margin: "10px 0 4px" }}>{children}</div>;
}
function Slider({ label, value, min, max, step, set, fmt }: { label: string; value: number; min: number; max: number; step: number; set: (v: number) => void; fmt: (v: number) => string }) {
  return (
    <label style={{ display: "block", fontSize: 10.5, color: "#9fb6c2", margin: "4px 0" }}>
      <span style={{ display: "flex", justifyContent: "space-between" }}><span>{label}</span><span>{fmt(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)} style={{ width: "100%" }} />
    </label>
  );
}

function useDrag(key: string, initial: { x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? initial; } catch { return initial; }
  });
  const clamp = (p: { x: number; y: number }) => {
    const r = ref.current?.getBoundingClientRect();
    return { x: Math.min(Math.max(6, p.x), innerWidth - (r?.width ?? 340) - 6), y: Math.min(Math.max(6, p.y), innerHeight - 60) };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = { mx: e.clientX, my: e.clientY, ...pos };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setPos(clamp({ x: s.x + ev.clientX - s.mx, y: s.y + ev.clientY - s.my }));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setPos((p) => { try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* ignore */ } return p; });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return { ref, pos, onPointerDown };
}

const S: Record<string, CSSProperties> = {
  panel: { position: "fixed", width: 340, maxHeight: "calc(100vh - 24px)", overflowY: "auto", pointerEvents: "auto", padding: 12, color: "#dff6ff", font: "11px/1.35 'JetBrains Mono', ui-monospace, monospace", background: "rgba(3,14,22,.96)", border: "1px solid rgba(46,234,124,.35)", borderRadius: 8, boxShadow: "0 12px 40px rgba(0,0,0,.5)" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 12 },
  x: { background: "none", border: "none", color: "#7fa2b2", cursor: "pointer" },
  live: { padding: "5px 7px", background: "rgba(46,234,124,.08)", border: "1px solid rgba(46,234,124,.2)", borderRadius: 4, color: "#9fe6bd" },
  row: { display: "flex", alignItems: "center", gap: 5, padding: "3px 4px", borderRadius: 4 },
  rowOn: { background: "rgba(46,234,124,.12)", boxShadow: "inset 2px 0 0 #2eea7c" },
  input: { background: "#061724", color: "#dff6ff", border: "1px solid rgba(46,234,124,.28)", borderRadius: 4, fontFamily: "inherit", fontSize: 11, padding: "2px 4px" },
  btn: { padding: "3px 7px", fontSize: 10.5, fontFamily: "inherit", background: "transparent", color: "#bfeed3", border: "1px solid rgba(46,234,124,.3)", borderRadius: 4, cursor: "pointer" },
  note: { fontSize: 10, color: "#5d7f90", marginTop: 6 },
  toast: { marginTop: 8, padding: "4px 8px", background: "#2eea7c", color: "#04121c", borderRadius: 4, fontSize: 11 },
};
