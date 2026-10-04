/**
 * The 311 story on the map: the call's pin, the crew's route drawing itself along the streets, the
 * crew driving it, then every crew's route for the day. Projected every frame (like the app's own
 * route overlay), each point resting on the ground at its sampled elevation.
 */
import { useEffect, useMemo, useRef } from "react";
import { DEPOT } from "../dispatch/ops311";
import type { CrewRoute } from "../dispatch/router";
import type { Engine } from "../engine";
import { project } from "../geo/projection";
import { useStore } from "../state/store";
import { pitch } from "./store";

type W = { x: number; z: number };
const DRAW_S = 2.6;
/** Seconds for the crew to drive the whole route, looping. */
const DRIVE_S = 14;

const smooth = (u: number) => u * u * (3 - 2 * u);

/** World points of a route, and the cumulative distance along it (km). */
function polyline(route: CrewRoute) {
  const pts: W[] = [];
  for (const l of route.legs) for (const q of l.path) pts.push(project(q.lat, q.lng));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] || 1 };
}

/** The point `f` (0..1) of the way along, and how many vertices come before it. */
function along(pl: ReturnType<typeof polyline>, f: number): { p: W; i: number } {
  const d = Math.max(0, Math.min(1, f)) * pl.len;
  let i = 1;
  while (i < pl.cum.length - 1 && pl.cum[i] < d) i++;
  const a = pl.pts[i - 1], b = pl.pts[i] ?? a, seg = pl.cum[i] - pl.cum[i - 1] || 1, t = (d - pl.cum[i - 1]) / seg;
  return { p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, i };
}

export function CallLayer({ engine }: { engine: Engine | null }) {
  const st = useStore(pitch, (s) => s.story311);
  const phase = useStore(pitch, (s) => s.call);
  const main = useMemo(() => (st ? polyline(st.route) : null), [st]);
  const others = useMemo(() => (st ? st.all.filter((r) => r.crew !== st.crew).map((r) => ({ ...r, pl: polyline(r.route) })) : []), [st]);

  const pinRef = useRef<SVGGElement>(null);
  const routeRef = useRef<SVGPathElement>(null);
  const casingRef = useRef<SVGPathElement>(null);
  const truckRef = useRef<SVGGElement>(null);
  const depotRef = useRef<SVGGElement>(null);
  const stopRefs = useRef<(SVGGElement | null)[]>([]);
  const otherRefs = useRef<(SVGPathElement | null)[]>([]);
  /** When the route started drawing (performance.now ms), or 0. */
  const drawFrom = useRef(0);
  const phaseRef = useRef(phase);
  useEffect(() => {
    if (phase >= 3 && phaseRef.current < 3) drawFrom.current = performance.now();
    if (phase < 3) drawFrom.current = 0;
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (!engine || !st || !main) return;
    // Ground elevations, sampled once per point (the route can cross a valley).
    const elev = new Map<string, number>();
    const key = (w: W) => `${w.x.toFixed(3)},${w.z.toFixed(3)}`;
    const ticketW = project(st.ticket.lat, st.ticket.lng), depotW = project(DEPOT.lat, DEPOT.lng);
    const stopsW = st.stops.map((t) => project(t.lat, t.lng));
    let alive = true;
    for (const w of [ticketW, depotW, ...stopsW, ...main.pts, ...others.flatMap((o) => o.pl.pts)]) {
      const k = key(w);
      if (elev.has(k)) continue;
      elev.set(k, NaN);
      void engine.groundElevation(w.x, w.z).then((v) => { if (alive) elev.set(k, v); }).catch(() => {});
    }
    const el = (w: W) => { const v = elev.get(key(w)); return v === undefined || Number.isNaN(v) ? undefined : v; };
    let raf = 0;
    const tick = () => {
      const scene = engine.scene, ph = phaseRef.current;
      if (scene) {
        const at = (w: W, e = el(w)) => scene.screenOf(w.x, w.z, e);
        const place = (g: SVGGElement | null, w: W, show: boolean) => {
          if (!g) return;
          const s = at(w);
          g.style.display = show && s.front ? "" : "none";
          if (show && s.front) g.setAttribute("transform", `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`);
        };
        place(pinRef.current, ticketW, ph >= 1 && ph < 4);
        place(depotRef.current, depotW, ph >= 3);
        stopsW.forEach((w, i) => place(stopRefs.current[i], w, ph >= 3));
        // The crew's route, drawn up to `f` of the way.
        const f = ph >= 3 ? (drawFrom.current ? smooth(Math.min(1, (performance.now() - drawFrom.current) / (DRAW_S * 1000))) : 1) : 0;
        let d = "";
        if (f > 0) {
          const end = along(main, f);
          const pts = [...main.pts.slice(0, end.i), end.p];
          let pen = false;
          for (const w of pts) {
            const s = at(w, el(w) ?? el(main.pts[Math.min(main.pts.length - 1, end.i)]));
            if (!s.front) { pen = false; continue; }
            d += `${pen ? "L" : "M"}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
            pen = true;
          }
        }
        routeRef.current?.setAttribute("d", d);
        casingRef.current?.setAttribute("d", d);
        // The crew drives once the route is drawn.
        const t = (performance.now() - drawFrom.current) / 1000 - DRAW_S;
        if (truckRef.current) {
          if (ph >= 3 && drawFrom.current && t > 0) {
            const q = along(main, (t % DRIVE_S) / DRIVE_S);
            const s = at(q.p, el(main.pts[Math.min(main.pts.length - 1, q.i)]));
            truckRef.current.style.display = s.front ? "" : "none";
            truckRef.current.setAttribute("transform", `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`);
          } else truckRef.current.style.display = "none";
        }
        // Every other crew's route (the day's plan).
        others.forEach((o, i) => {
          const p = otherRefs.current[i];
          if (!p) return;
          if (ph < 4) { p.setAttribute("d", ""); return; }
          let od = "", pen = false;
          for (const w of o.pl.pts) {
            const s = at(w);
            if (!s.front) { pen = false; continue; }
            od += `${pen ? "L" : "M"}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
            pen = true;
          }
          p.setAttribute("d", od);
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [engine, st, main, others]);

  if (!st) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 z-[3] h-full w-full overflow-visible" aria-hidden>
      <g className="pitch-fade" style={{ opacity: phase >= 4 ? 1 : 0 }}>
        {others.map((o, i) => (
          <path key={o.crew} ref={(r) => { otherRefs.current[i] = r; }} fill="none" stroke={o.color} strokeWidth={3} strokeOpacity={0.75} strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </g>
      <path ref={casingRef} fill="none" stroke="#06100c" strokeWidth={9} strokeOpacity={0.55} strokeLinejoin="round" strokeLinecap="round" />
      <path ref={routeRef} fill="none" stroke={st.crewColor} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 6px ${st.crewColor})` }} />
      <g ref={depotRef} style={{ display: "none" }}>
        <rect x={-9} y={-9} width={18} height={18} rx={3} fill="#0b1210" stroke="#e8f5ee" strokeWidth={2} />
        <text y={4} textAnchor="middle" fontSize={10} fontWeight={700} fill="#e8f5ee">D</text>
      </g>
      {st.stops.map((s, i) => (
        <g key={s.id} ref={(r) => { stopRefs.current[i] = r; }} style={{ display: "none" }}>
          <circle r={10} fill="#0b1210" stroke={st.crewColor} strokeWidth={2.5} />
          <text y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">{i + 1}</text>
        </g>
      ))}
      <g ref={pinRef} style={{ display: "none" }}>
        <circle className="pitch-ping" r={14} fill="none" stroke="#ff5a36" strokeWidth={3} />
        <circle className="pitch-ping pitch-ping-late" r={14} fill="none" stroke="#ff5a36" strokeWidth={2} />
        <circle r={9} fill="#ff5a36" stroke="#fff" strokeWidth={2.5} />
      </g>
      <g ref={truckRef} style={{ display: "none" }}>
        <circle r={13} fill={st.crewColor} fillOpacity={0.25} />
        <circle r={7} fill={st.crewColor} stroke="#fff" strokeWidth={2.5} />
      </g>
    </svg>
  );
}
