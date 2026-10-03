/**
 * Driving routes for the 311 crews, drawn over the map: the crew in the queue (or every crew),
 * along the streets the route planner chose (dispatch/router.ts), in the crew's colour.
 * Projected every frame like the pins; each route point sits on the ground (its sampled elevation).
 */
import { useEffect, useMemo, useRef } from "react";
import { crewColor } from "../dispatch/colors";
import { dispatch } from "../dispatch/store";
import type { CrewRoute } from "../dispatch/router";
import type { Engine } from "../engine";
import { project } from "../geo/projection";
import { useStore } from "../state/store";

interface Drawn { crew: string; color: string; strong: boolean; route: CrewRoute }

/** Ground elevations per route, sampled once (route objects are replaced when they change). */
const elevCache = new WeakMap<CrewRoute, (number | undefined)[]>();

export function RouteOverlay({ engine }: { engine: Engine | null }) {
  const d = useStore(dispatch, (s) => s);
  const drawn = useMemo<Drawn[]>(() => {
    const p = d.plan311;
    if (!d.open || d.tab !== "311" || !p) return [];
    const crews = d.at === "noon" && p.noon ? p.noonCrews : p.crews;
    const current = crews[Math.min(d.cursor311, crews.length - 1)]?.id;
    return crews
      .filter((c) => d.routes[c.id] && (d.showAllRoutes || c.id === current))
      .map((c) => ({ crew: c.id, color: crewColor(p.crews.findIndex((x) => x.id === c.id)), strong: c.id === current, route: d.routes[c.id] }))
      .sort((a, b) => Number(a.strong) - Number(b.strong)); // the current crew on top
  }, [d.open, d.tab, d.plan311, d.at, d.cursor311, d.routes, d.showAllRoutes]);

  const paths = useRef<(SVGPathElement | null)[]>([]);
  const casings = useRef<(SVGPathElement | null)[]>([]);
  useEffect(() => {
    if (!engine || !drawn.length) return;
    const pts = drawn.map((r) => r.route.legs.flatMap((l) => l.path).map((q) => project(q.lat, q.lng)));
    drawn.forEach((r, i) => {
      if (elevCache.has(r.route)) return;
      const e: (number | undefined)[] = [];
      elevCache.set(r.route, e);
      void Promise.all(pts[i].map((w, k) => engine.groundElevation(w.x, w.z).then((v) => { e[k] = v; }).catch(() => {})));
    });
    let raf = 0;
    const tick = () => {
      const scene = engine.scene;
      if (scene) {
        drawn.forEach((r, i) => {
          const elev = elevCache.get(r.route) ?? [];
          let dStr = "", pen = false;
          pts[i].forEach((w, k) => {
            const s = scene.screenOf(w.x, w.z, elev[k]);
            if (!s.front) { pen = false; return; }
            dStr += `${pen ? "L" : "M"}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
            pen = true;
          });
          paths.current[i]?.setAttribute("d", dStr);
          casings.current[i]?.setAttribute("d", dStr);
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, drawn]);

  if (!drawn.length) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 z-[2] h-full w-full overflow-visible">
      {drawn.map((r, i) => (
        <g key={r.crew} opacity={r.strong ? 1 : 0.55}>
          <path ref={(el) => { casings.current[i] = el; }} fill="none" stroke="rgb(0 0 0 / 0.55)" strokeWidth={r.strong ? 7 : 5} strokeLinecap="round" strokeLinejoin="round" />
          <path ref={(el) => { paths.current[i] = el; }} fill="none" stroke={r.color} strokeWidth={r.strong ? 4 : 2.5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={r.strong ? undefined : "6 5"} />
        </g>
      ))}
    </svg>
  );
}
