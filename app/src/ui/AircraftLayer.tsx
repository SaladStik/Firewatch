/**
 * Wildfire dispatch on the map:
 *  - LIVE: firefighting aircraft in the air right now (adsb.lol through the data server), moved
 *    smoothly between updates from their speed and track (dead reckoning), with a short trail;
 *  - SIM: the dispatched resources flying their sorties. Helitack crews fly out and circle their
 *    fire, unit crews drive out, skimmers shuttle fire ↔ lake (scooping), air tankers shuttle
 *    fire ↔ base (reloading). The clock runs SIM_SPEED× real time so a 40-minute ETA plays in 20 s.
 * Drawn as an SVG overlay projected every frame, like the 311 routes; each point sits at its ground
 * elevation plus a little altitude for aircraft.
 */
import { useEffect, useMemo, useRef } from "react";

import { FLY_IN_KM, KIND, type FireDispatch, type ResourceKind } from "../dispatch/fleet";
import { haversineKm } from "../dispatch/csv";
import { dispatch } from "../dispatch/store";
import type { Engine } from "../engine";
import { project } from "../geo/projection";
import { useStore } from "../state/store";

/** Simulated minutes per real second. */
const SIM_SPEED = 2;

type LL = { lat: number; lng: number };
const COLOR: Record<ResourceKind | "live", string> = { helitack: "#ffd23f", unit: "#2ee38a", airtanker: "#ff5a36", skimmer: "#36b8ff", live: "#ff9f1a" };
/** Height above ground drawn for each (m). */
const ALT: Record<ResourceKind, number> = { helitack: 250, unit: 0, airtanker: 600, skimmer: 400 };

interface Actor {
  key: string;
  kind: ResourceKind;
  label: string;
  title: string;
  base: LL;
  fire: LL;
  /** Second end of the shuttle: the lake (skimmer) or the base (air tanker). */
  shuttle: LL | null;
  getaway: number;
  /** Unit crews flown in (remote fire) instead of driven. */
  flown: boolean;
  /** Minutes in the air base → fire, and per shuttle round trip (incl. scoop / reload). */
  outbound: number;
  cycle: number;
  pause: number;
}

const lerp = (a: LL, b: LL, t: number): LL => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

/** Where an actor is at sim minute t. */
/**
 * Where an actor is at sim minute t, and which way it's heading (the leg it's on: `to` is the point
 * it's flying toward; null while it's parked, so it keeps its last heading instead of spinning).
 */
function positionAt(a: Actor, t: number): { p: LL; flying: boolean; phase: string; to: LL | null } {
  if (t < a.getaway) return { p: a.base, flying: false, phase: "getting away", to: null };
  const f = t - a.getaway;
  if (f < a.outbound) return { p: lerp(a.base, a.fire, f / a.outbound), flying: a.kind !== "unit" || a.flown, phase: "en route", to: a.fire };
  const on = f - a.outbound;
  // Helitack crews land and work the fire; unit crews arrive and stay.
  if (!a.shuttle) return { p: a.fire, flying: false, phase: "on the fire", to: null };
  // Shuttle: fire → shuttle point (out), pause (scoop / reload), back to the fire, drop.
  const leg = (a.cycle - a.pause) / 2, c = on % a.cycle;
  if (c < leg) return { p: lerp(a.fire, a.shuttle, c / leg), flying: true, phase: a.kind === "skimmer" ? "to the lake" : "to base to reload", to: a.shuttle };
  if (c < leg + a.pause) return { p: a.shuttle, flying: a.kind === "skimmer", phase: a.kind === "skimmer" ? "scooping" : "reloading", to: null };
  return { p: lerp(a.shuttle, a.fire, (c - leg - a.pause) / leg), flying: true, phase: "back to drop", to: a.fire };
}

function actorsOf(list: FireDispatch[]): Actor[] {
  const out: Actor[] = [];
  for (const fd of list) {
    for (const as of fd.assignments) {
      const r = as.resource, k = KIND[r.kind];
      const base = { lat: r.base.lat, lng: r.base.lng }, fire = { lat: fd.fire.fire.lat, lng: fd.fire.fire.lng };
      const shuttle = r.kind === "skimmer" ? (as.lake ? { lat: as.lake.lat, lng: as.lake.lng } : null) : r.kind === "airtanker" ? base : null;
      const pause = r.kind === "skimmer" ? 2 : r.kind === "airtanker" ? 20 : 0;
      out.push({
        key: `${r.id}->${fd.fire.fire.id}`, kind: r.kind, label: `SIM ${k.short} ${r.base.id}`,
        flown: r.kind === "unit" && haversineKm(r.base.lat, r.base.lng, fd.fire.fire.lat, fd.fire.fire.lng) > FLY_IN_KM,
        title: `${k.label} ${r.id} from ${r.base.name} → ${fd.fire.fire.id}${fd.fire.fire.name ? ` ${fd.fire.fire.name}` : ""}: ETA ${Math.round(as.eta)} min${as.dropsPerHour ? `, ${as.dropsPerHour.toFixed(1)} drops/h` : ""}`,
        base, fire, shuttle, getaway: k.getawayMin, outbound: Math.max(1, as.eta - k.getawayMin), cycle: as.cycleMin ?? 0, pause,
      });
    }
  }
  return out;
}

/** Top-down plane / helicopter / truck glyphs (24-unit box, nose up). */
const GLYPH: Record<ResourceKind | "live", string> = {
  airtanker: "M12 2l1.6 6.5 8.4 4v2l-8.4-2-.8 5.5 3 2v1.6L12 20.3 8.2 21.6V20l3-2-.8-5.5-8.4 2v-2l8.4-4z",
  skimmer: "M12 2l1.4 6.5 9.6 1.8v1.8l-9.6-.6-.6 6.8 3 1.8v1.4L12 20.2l-3.8 1.3v-1.4l3-1.8-.6-6.8-9.6.6v-1.8l9.6-1.8z",
  live: "M12 2l1.6 6.5 8.4 4v2l-8.4-2-.8 5.5 3 2v1.6L12 20.3 8.2 21.6V20l3-2-.8-5.5-8.4 2v-2l8.4-4z",
  helitack: "M11 4h2v5h7v2h-7v4l2 2v1H9v-1l2-2v-4H4V9h7z",
  // A crew truck seen from above (nose up): cab and box.
  unit: "M9 4h6l1 3v13h-8V7z M9.5 8h5v2h-5z",
};
/** Unit crews flown in to remote fires: drawn as a transport plane. */
const FLOWN = "M12 3l1.2 5.5 7.8 3.5v1.8l-7.8-1.6-.6 5 2.6 1.8v1.4L12 19.3l-3.2 1.1V19l2.6-1.8-.6-5L3 13.8V12l7.8-3.5z";
/** Icon size (px) per kind: aircraft bigger than ground crews. */
const SIZE: Record<ResourceKind, number> = { airtanker: 1, skimmer: 1, helitack: 0.85, unit: 0.7 };

export function AircraftLayer({ engine }: { engine: Engine | null }) {
  const d = useStore(dispatch, (s) => s);
  const on = d.open && d.tab === "crews";
  // Only what the dispatcher is working on: the fire on the queue card (a preview of who'd go) and
  // the fires already dispatched. Not every fire on the list at once.
  const cursorFire = d.plan?.pickedCut[Math.min(d.cursor, Math.max(0, (d.plan?.pickedCut.length ?? 1) - 1))];
  const actors = useMemo(() => (on && d.simulate
    ? actorsOf(d.fleetDispatch.filter((fd) => fd.fire === cursorFire || d.decided[`${fd.fire.fire.year}:${fd.fire.fire.id}`] === "sent"))
    : []), [on, d.simulate, d.fleetDispatch, cursorFire, d.decided]);
  const live = useMemo(() => (on && d.showLiveAircraft ? d.liveAircraft : []), [on, d.showLiveAircraft, d.liveAircraft]);
  const liveAt = d.aircraftAt ? Date.parse(d.aircraftAt) : 0;

  const icons = useRef<(SVGGElement | null)[]>([]);
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const liveIcons = useRef<(SVGGElement | null)[]>([]);
  const trails = useRef<(SVGPathElement | null)[]>([]);
  const history = useRef(new Map<string, LL[]>());
  // The sim clock and headings live across re-renders (e.g. each live-aircraft update): only a new
  // dispatch restarts the sorties.
  /** Each sortie's own start (when it was first shown / dispatched), so others don't restart. */
  const starts = useRef(new Map<string, number>());
  const hdgRef = useRef(new Map<string, number>());

  // Live trails: remember each aircraft's reported positions across updates.
  useEffect(() => {
    for (const a of live) {
      const h = history.current.get(a.hex) ?? [];
      const last = h.at(-1);
      if (!last || last.lat !== a.lat || last.lng !== a.lng) h.push({ lat: a.lat, lng: a.lng });
      history.current.set(a.hex, h.slice(-12));
    }
  }, [live]);

  useEffect(() => {
    if (!engine || (!actors.length && !live.length)) return;
    // Ground elevations for the fixed points (bases, fires, lakes), interpolated along the legs.
    const elev = new Map<string, number>();
    const key = (p: LL) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
    const want = new Map<string, LL>();
    for (const a of actors) for (const p of [a.base, a.fire, a.shuttle]) if (p) want.set(key(p), p);
    for (const a of live) want.set(key(a), a);
    let alive = true;
    want.forEach((p, k) => { const w = project(p.lat, p.lng); void engine.groundElevation(w.x, w.z).then((e) => { if (alive) elev.set(k, e); }).catch(() => {}); });
    const groundAt = (a: LL, b: LL, p: LL) => {
      const ea = elev.get(key(a)), eb = elev.get(key(b));
      if (ea === undefined && eb === undefined) return undefined;
      const span = Math.hypot(b.lat - a.lat, b.lng - a.lng) || 1, t = Math.min(1, Math.hypot(p.lat - a.lat, p.lng - a.lng) / span);
      return (ea ?? eb!) * (1 - t) + (eb ?? ea!) * t;
    };
    const hdg = hdgRef.current;
    let raf = 0;
    const tick = () => {
      const scene = engine.scene;
      if (scene) {
        const at = (p: LL, elevM: number | undefined) => { const w = project(p.lat, p.lng); return scene.screenOf(w.x, w.z, elevM); };
        /** Screen heading (deg, 0 = up) of motion from p toward q. */
        const heading = (p: LL, q: LL, e: number | undefined) => { const a = at(p, e), b = at(q, e); return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI; };
        const nowMs = performance.now();
        actors.forEach((a, i) => {
          const g = icons.current[i], path = paths.current[i];
          if (!g) return;
          let start = starts.current.get(a.key);
          if (start === undefined) starts.current.set(a.key, (start = nowMs));
          const simMin = ((nowMs - start) / 1000) * SIM_SPEED;
          const { p, flying, to } = positionAt(a, simMin);
          const legFrom = a.shuttle && simMin > a.getaway + a.outbound ? a.fire : a.base, legTo = a.shuttle && simMin > a.getaway + a.outbound ? a.shuttle : a.fire;
          const ground = groundAt(legFrom, legTo, p);
          const s = at(p, ground !== undefined ? ground + (flying ? ALT[a.kind] : 0) : undefined);
          if (!s.front) { g.style.display = "none"; } else {
            g.style.display = "";
            // Heading: along the leg; parked (scooping, reloading, at base) keeps the last one.
            // Eased toward the target so turns are smooth, never a snap or a spin.
            if (to && (to.lat !== p.lat || to.lng !== p.lng)) {
              const target = heading(p, to, ground), cur = hdg.get(a.key) ?? target;
              const diff = ((target - cur + 540) % 360) - 180;
              hdg.set(a.key, cur + diff * 0.15);
            }
            const hd = hdg.get(a.key) ?? 0;
            g.setAttribute("transform", `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`);
            g.firstElementChild?.setAttribute("transform", `rotate(${hd.toFixed(1)}) scale(${SIZE[a.kind]}) translate(-12,-12)`);
          }
          if (path) {
            const pts = [a.base, a.fire, ...(a.shuttle && a.shuttle !== a.base ? [a.shuttle, a.fire] : [])].map((q) => at(q, elev.get(key(q))));
            path.setAttribute("d", pts.every((q) => q.front) ? pts.map((q, k) => `${k ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join("") : "");
          }
        });
        const now = Date.now();
        live.forEach((a, i) => {
          const g = liveIcons.current[i], trail = trails.current[i];
          if (!g) return;
          // Dead reckoning since the report: knots → km/h, along the track.
          const hours = Math.min(180, (now - liveAt) / 1000 + a.seen) / 3600, km = a.gsKt * 1.852 * hours, rad = (a.track * Math.PI) / 180;
          const p = { lat: a.lat + (km * Math.cos(rad)) / 111.2, lng: a.lng + (km * Math.sin(rad)) / (111.2 * Math.cos((a.lat * Math.PI) / 180)) };
          const ground = elev.get(key(a));
          const s = at(p, ground !== undefined ? ground + (a.altFt ?? 0) * 0.3048 : undefined);
          if (!s.front) { g.style.display = "none"; return; }
          g.style.display = "";
          const nose = { lat: p.lat + Math.cos(rad) * 0.01, lng: p.lng + (Math.sin(rad) * 0.01) / Math.cos((p.lat * Math.PI) / 180) };
          g.setAttribute("transform", `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`);
          g.firstElementChild?.setAttribute("transform", `rotate(${heading(p, nose, ground).toFixed(0)}) translate(-12,-12)`);
          if (trail) {
            const h = [...(history.current.get(a.hex) ?? []), p].map((q) => at(q, ground));
            trail.setAttribute("d", h.filter((q) => q.front).map((q, k) => `${k ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(""));
          }
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [engine, actors, live, liveAt]);

  if (!actors.length && !live.length) return null;
  return (
    <svg data-layer="aircraft" className="pointer-events-none absolute inset-0 z-[3] h-full w-full overflow-visible">
      {actors.map((a, i) => (
        <path key={`p:${a.key}`} ref={(el) => { paths.current[i] = el; }} fill="none" stroke={COLOR[a.kind]} strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray={a.kind === "unit" ? "2 4" : "6 5"} />
      ))}
      {live.map((a, i) => (
        <path key={`t:${a.hex}`} ref={(el) => { trails.current[i] = el; }} fill="none" stroke={COLOR.live} strokeOpacity={0.6} strokeWidth={2} />
      ))}
      {actors.map((a, i) => (
        <g key={a.key} ref={(el) => { icons.current[i] = el; }} style={{ display: "none" }} className="pointer-events-auto" data-actor={a.key}>
          <g><path d={a.flown ? FLOWN : GLYPH[a.kind]} fill={COLOR[a.kind]} stroke="rgb(0 0 0 / 0.75)" strokeWidth={1} /></g>
          <text x={11} y={-7} fontSize={9} fontWeight={600} fill={COLOR[a.kind]} stroke="rgb(0 0 0 / 0.75)" strokeWidth={2.5} paintOrder="stroke">{a.label}</text>
          <title>{a.title}{a.flown ? " (flown in)" : ""} (simulated)</title>
        </g>
      ))}
      {live.map((a, i) => (
        <g key={a.hex} ref={(el) => { liveIcons.current[i] = el; }} style={{ display: "none" }} className="pointer-events-auto">
          <g><path d={GLYPH.live} fill={COLOR.live} stroke="#fff" strokeWidth={1.2} /></g>
          <text x={14} y={4} fontSize={10} fontWeight={700} fill="#fff" stroke="rgb(0 0 0 / 0.8)" strokeWidth={3} paintOrder="stroke">{a.reg || a.callsign} · {a.type} · {a.altFt ? `${Math.round(a.altFt / 100) * 100} ft` : "ground"}</text>
          <title>LIVE {a.name}: {a.reg} {a.callsign}, {Math.round(a.gsKt)} kt, track {Math.round(a.track)}° (adsb.lol)</title>
        </g>
      ))}
    </svg>
  );
}

