/**
 * Map pins for the Dispatch panel: 311 tickets coloured by crew (with stop numbers; grey = waiting,
 * snowflake = blizzard call), and the crewed fires' rank badges (ringed red when they lost a crew).
 * Positioned every frame from the 3D map, like the place labels.
 */
import { useEffect, useMemo, useRef } from "react";
import { label } from "../dispatch/crews";
import { flyTo } from "../dispatch/controller";
import { typeOf } from "../dispatch/ops311";
import { dispatch } from "../dispatch/store";
import type { Engine } from "../engine";
import { project } from "../geo/projection";
import { useStore } from "../state/store";
import { crewColor } from "../dispatch/colors";

/** Most waiting tickets drawn as map pins (highest priority first). */
const WAITING_PINS = 300;

interface Pin {
  key: string;
  lat: number;
  lng: number;
  text: string;
  title: string;
  color: string;
  ring?: string;
  small?: boolean;
  zoom: number;
}

export function DispatchPins({ engine }: { engine: Engine | null }) {
  const d = useStore(dispatch, (s) => s);
  const pins = useMemo<Pin[]>(() => {
    if (!d.open) return [];
    if (d.tab === "311") {
      const p = d.plan311;
      if (!p) return [];
      const noon = d.at === "noon" && p.noon;
      const view = noon ? p.noon! : p.morning;
      const out: Pin[] = [];
      const assigned = new Set<string>();
      view.routes.forEach((planned, crew) => {
        const i = p.crews.findIndex((c) => c.id === crew);
        // Stop numbers follow the driving order when the route planner re-ordered the stops.
        const order = d.routes[crew]?.order;
        const jobs = order && order.length === planned.length ? order.map((j) => planned[j]) : planned;
        jobs.forEach((t, k) => {
          assigned.add(t.id);
          out.push({ key: t.id, lat: t.lat, lng: t.lng, text: `${k + 1}`, title: `${crew} stop ${k + 1}: ${typeOf(t.service).label}, ${t.community}`, color: crewColor(i), ring: t.simulated ? "#bfe6ff" : undefined, zoom: 2.5 });
        });
      });
      // Waiting tickets: only the most urgent (the live queue holds ~25,000; the list shows them all).
      for (const t of view.waiting.slice(0, WAITING_PINS)) {
        if (assigned.has(t.id)) continue;
        out.push({ key: t.id, lat: t.lat, lng: t.lng, text: "", title: `Waiting: ${typeOf(t.service).label}, ${t.community}`, color: t.simulated ? "#9fd8ff" : "#8a948e", small: true, zoom: 2.5 });
      }
      return out;
    }
    const plan = d.plan;
    if (!plan) return [];
    const lost = new Set(plan.lostCrew.map((s) => `${s.fire.year}:${s.fire.id}`));
    return plan.picked.map((s, i) => ({
      key: `${s.fire.year}:${s.fire.id}`, lat: s.fire.lat, lng: s.fire.lng, text: `${i + 1}`,
      title: `#${i + 1} ${label(s)}${lost.has(`${s.fire.year}:${s.fire.id}`) ? " (lost a crew in the cut)" : ""}: ${s.reason}`,
      color: "#ff7a1a", ring: lost.has(`${s.fire.year}:${s.fire.id}`) ? "#ff2f4f" : undefined, zoom: 40,
    }));
  }, [d.open, d.tab, d.plan311, d.at, d.plan, d.routes]);

  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!engine || !pins.length) return;
    const world = pins.map((p) => project(p.lat, p.lng));
    // Ground elevation per pin, so pins stay on the surface where no hex is loaded under them.
    const elev: (number | undefined)[] = [];
    let alive = true;
    void Promise.all(world.map((w) => engine.groundElevation(w.x, w.z).catch(() => undefined))).then((e) => { if (alive) e.forEach((v, i) => { elev[i] = v; }); });
    let raf = 0;
    const tick = () => {
      const scene = engine.scene;
      if (scene) {
        pins.forEach((_, i) => {
          const el = refs.current[i];
          if (!el) return;
          const s = scene.screenOf(world[i].x, world[i].z, elev[i]);
          if (!s.visible) { el.style.display = "none"; return; }
          el.style.display = "";
          el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [engine, pins]);

  if (!pins.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[2] overflow-hidden">
      {pins.map((p, i) => (
        <button
          key={p.key}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          title={p.title}
          onClick={() => flyTo(p.lat, p.lng, p.zoom)}
          className="pointer-events-auto absolute left-0 top-0 grid place-items-center rounded-full font-mono font-bold text-black"
          style={{
            display: "none",
            width: p.small ? 8 : 18, height: p.small ? 8 : 18, fontSize: 10,
            background: p.color,
            boxShadow: `0 0 0 ${p.ring ? 2.5 : 1}px ${p.ring ?? "rgb(0 0 0 / 0.55)"}, 0 1px 4px rgb(0 0 0 / 0.4)`,
            willChange: "transform",
          }}
        >
          {p.small ? null : p.text}
        </button>
      ))}
    </div>
  );
}
