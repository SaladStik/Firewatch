/**
 * FIRE//WATCH loading screen.
 *
 * A fire lookout tower draws itself as loading progresses (legs → bracing → platform → cab →
 * roof → antenna). The firefly (the standard mascot, small) flies up around the tower in a
 * smooth spiral — in front of it on the near side, behind it on the far side — banking into
 * the curves, with a short fading comet tail and a few sparkles. When loading finishes he
 * reaches the top and lights the tower: a flash at the beacon, the cab windows glow and the
 * beacon sweeps. A frame beside it ticks off what's loading.
 *
 * Pacing: the animation runs a little BEHIND the real progress and moves with momentum, so
 * when a step takes a while it slows down smoothly instead of stopping dead, and a burst of
 * progress becomes a smooth speed-up instead of a jump. If loading truly stalls it keeps
 * creeping (never more than LEAD ahead of the real progress, and never finishing early).
 *
 * Performance: the app boots behind this screen, so the main thread is busy. Nothing here
 * re-renders React per frame: one animation loop writes straight to the DOM (CSS variables for
 * the tower, transforms for the firefly, a canvas for sparkles). React only re-renders when the
 * shown percentage or a checklist item changes; the mascot re-renders just its own small SVG.
 *
 * Pure presentation: give it `progress` (0..1), a `stage` label and optionally an `error`.
 * Used by the app's boot overlay (ui/Overlays.tsx) and the test page (/loading.html).
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Firefly, useFirefly, type FireflyController } from "../../mascot/firefly";

export interface LoadingScreenProps {
  /** 0..1 */
  progress: number;
  stage?: string;
  error?: string | null;
  /** Show the firefly and his trail. */
  firefly?: boolean;
  /**
   * Called once the finale has played (he's at the top, the beacon has flashed and the tower is
   * lit), so the app can fade the screen out without cutting the animation short.
   */
  onComplete?: () => void;
}

/** How long the lit tower shows (flash + windows + first beacon sweep) before onComplete. */
const FINALE_S = 1.4;

/** What's loading, and the progress at which each is done (matches the app's boot sequence). */
export const LOAD_STEPS: { label: string; source: string; doneAt: number }[] = [
  { label: "Elevation & land cover", source: "AWS Terrain · ESA WorldCover", doneAt: 0.4 },
  { label: "Rivers, roads, rail & towns", source: "OpenStreetMap", doneAt: 0.8 },
  { label: "Highway traffic volumes", source: "Alberta TEC", doneAt: 0.85 },
  { label: "Live fire hotspots & perimeters", source: "CWFIS · NRCan", doneAt: 0.9 },
  { label: "Weather & 7-day forecast", source: "Open-Meteo", doneAt: 0.9 },
  { label: "Fire danger (FWI System)", source: "CFFDRS", doneAt: 0.96 },
  { label: "Fire growth projections", source: "FBP · fuel map", doneAt: 1 },
];

/** Stage (tower + flight) size in px; the tower sits inside it at TOWER_X, TOWER_Y. */
const STAGE_W = 380, STAGE_H = 320, TOWER_X = 80, TOWER_Y = 24;
/** Firefly size (px): the standard mascot, small. */
const SPRITE = 34;
/**
 * The flight: a smooth spiral up around the tower, ending beside the beacon. Waypoints are
 * joined with a Catmull-Rom spline, so there are no hard turns.
 */
const WAYPOINTS: [number, number][] = [[30, 312], [130, 300], [270, 268], [300, 226], [230, 196], [110, 176], [72, 140], [140, 112], [262, 96], [276, 64], [228, 36], [206, 26]];
const FLIGHT = catmullRom(WAYPOINTS);
/** Length of the fading comet tail behind him, as a share of the whole flight. */
const TAIL = 0.14;

// ---- pacing (progress units are 0..1)
/** How far behind the real progress the animation trails: it closes the gap over ~this many seconds. */
const LAG_S = 1.1;
/** Fastest it moves: the whole bar in no less than this many seconds. */
const MIN_RUN_S = 3.2;
/** How quickly its speed can change (1/s): momentum, so it never stops or starts abruptly. */
const ACCEL = 2.2;
/** While loading stalls it keeps creeping at this speed… */
const CREEP = 0.008;
/** …but never more than this far ahead of the real progress, and never past HOLD until it's done. */
const LEAD = 0.025, HOLD = 0.985;
/** Once loading is finished, close the remaining gap over about this long. */
const FINISH_S = 0.6;

function catmullRom(pts: [number, number][]): string {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

const PARTS: { from: number; to: number }[] = [
  { from: 0.0, to: 0.38 }, // legs
  { from: 0.22, to: 0.62 }, // bracing
  { from: 0.58, to: 0.72 }, // platform + railing
  { from: 0.68, to: 0.86 }, // cab
  { from: 0.84, to: 0.95 }, // roof
  { from: 0.93, to: 1.0 }, // antenna
];
const part = (p: number, i: number) => Math.min(1, Math.max(0, (p - PARTS[i].from) / (PARTS[i].to - PARTS[i].from)));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/**
 * One pacing step: move the shown progress `s` (with velocity `v`) toward the real progress `t`.
 * Exported for tests.
 */
export function paceStep(s: number, v: number, t: number, dt: number): { s: number; v: number } {
  if (t < s - LEAD - 1e-6) return { s: t, v: 0 }; // progress reset (new load): follow it down at once
  const done = t >= 1;
  const gap = t - s;
  let want = done ? gap / FINISH_S : gap / LAG_S;
  if (!done) want = Math.max(want, CREEP * clamp((t + LEAD - s) / LEAD, 0, 1)); // keep creeping, easing off near the lead limit
  want = clamp(want, 0, done ? 1 / FINISH_S : 1 / MIN_RUN_S);
  v += (want - v) * Math.min(1, dt * ACCEL);
  s = Math.min(s + v * dt, done ? 1 : Math.min(HOLD, t + LEAD));
  if (done && 1 - s < 0.002) s = 1;
  return { s, v };
}

export function LoadingScreen({ progress, stage = "loading", error = null, firefly = true, onComplete }: LoadingScreenProps) {
  const target = useRef(progress);
  useEffect(() => { target.current = progress; }, [progress]);
  /** The displayed progress, shared with the flight loop. */
  const shown = useRef(0);
  const towerRef = useRef<SVGSVGElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // React state only for things that change rarely.
  const [pct, setPct] = useState(0);
  const [lit, setLit] = useState(false);
  const errorRef = useRef(error);
  useEffect(() => { errorRef.current = error; }, [error]);
  const completeRef = useRef(onComplete);
  useEffect(() => { completeRef.current = onComplete; }, [onComplete]);
  // Finale: once the tower is lit, let it play, then report completion (once).
  useEffect(() => {
    if (!lit) return;
    const t = setTimeout(() => completeRef.current?.(), FINALE_S * 1000);
    return () => clearTimeout(t);
  }, [lit]);

  useEffect(() => {
    let raf = 0, last = performance.now(), lastPct = -1, wasLit = false, v = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const next = paceStep(shown.current, v, target.current, dt);
      shown.current = next.s; v = next.v;
      const s = next.s;
      const svg = towerRef.current;
      if (svg) for (let i = 0; i < PARTS.length; i++) svg.style.setProperty(`--p${i}`, part(s, i).toFixed(4));
      if (barRef.current) barRef.current.style.width = `${(s * 100).toFixed(2)}%`;
      const p = Math.round(s * 100);
      if (p !== lastPct) { lastPct = p; setPct(p); }
      const nowLit = s >= 1 && !errorRef.current;
      if (nowLit !== wasLit) { wasLit = nowLit; setLit(nowLit); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex select-none flex-col items-center gap-6 md:flex-row md:items-center md:gap-10">
      <div className="flex flex-col items-center gap-4">
        <div className="relative" style={{ width: STAGE_W, height: STAGE_H }}>
          <div className="absolute" style={{ left: TOWER_X, top: TOWER_Y, width: 220, height: 286, zIndex: 2 }}>
            <Tower svgRef={towerRef} lit={lit} />
          </div>
          {firefly && <Flight shown={shown} arrived={lit} />}
        </div>
        <div className="text-[20px] font-bold tracking-[0.32em] text-ink glow-text">
          FIRE<span className="text-phos">//</span>WATCH
        </div>
        <div className="h-[3px] w-64 overflow-hidden border border-line">
          {!error && <div ref={barRef} className="h-full bg-phos" style={{ width: 0, boxShadow: "0 0 8px var(--color-phos)" }} />}
        </div>
      </div>
      <LoadFrame pct={pct} stage={stage} error={error} />
    </div>
  );
}

// ---------------------------------------------------------------- the loading frame
const LoadFrame = memo(function LoadFrame({ pct, stage, error }: { pct: number; stage: string; error: string | null }) {
  const p = pct / 100;
  const active = LOAD_STEPS.findIndex((s) => p < s.doneAt - 1e-3);
  return (
    <div className="panel w-[300px] p-3 text-[11px]">
      <div className="mb-2 flex items-center justify-between border-b border-line pb-2">
        <span className="label-xs text-phos">SYSTEM CHECK</span>
        <span className="tabular-nums text-ink-mute">{pct}%</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {LOAD_STEPS.map((s, i) => {
          const isDone = p >= s.doneAt - 1e-3, isActive = i === active && !error;
          return (
            <li key={s.label} className="flex items-start gap-2">
              <span className={`mt-[1px] w-3 shrink-0 text-center ${isDone ? "text-phos" : isActive ? "animate-pulse text-[#ffb347]" : "text-ink-mute"}`}>
                {isDone ? "✓" : isActive ? "●" : "○"}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={isDone || isActive ? "text-ink" : "text-ink-mute"}>{s.label}</span>
                <span className="text-[9.5px] tracking-wider text-ink-mute">{s.source}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 border-t border-line pt-2 text-[10px] tracking-[0.18em] text-ink-mute">
        {error ? <span className="text-fire">{error}</span> : <>{stage.toUpperCase()}<span className="animate-pulse">_</span></>}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- the tower
/** Draw-on driven by CSS variables --p0..--p5 (set by the loop), so it never re-renders for progress. */
const Tower = memo(function Tower({ svgRef, lit }: { svgRef: RefObject<SVGSVGElement | null>; lit: boolean }) {
  const line = "var(--color-phos)";
  const dim = "color-mix(in srgb, var(--color-phos) 45%, transparent)";
  const warm = "#ffb347";
  const draw = (i: number) => ({ strokeDasharray: 1, strokeDashoffset: `calc(1 - var(--p${i}, 0))` });
  const legs = draw(0), brace = draw(1), deck = draw(2), cab = draw(3), roof = draw(4), mast = draw(5);

  return (
    <svg ref={svgRef} viewBox="0 0 220 286" width="100%" height="100%" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: "visible", filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--color-phos) 55%, transparent))" }}>
      <defs>
        <radialGradient id="ew-beam" cx="0" cy="0.5" r="1">
          <stop offset="0" stopColor={warm} stopOpacity="0.55" />
          <stop offset="1" stopColor={warm} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ew-cabglow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={warm} stopOpacity="0.35" />
          <stop offset="1" stopColor={warm} stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M10 276 H210" stroke={dim} strokeWidth="1.2" pathLength={1} style={legs} />
      <g stroke={dim} strokeWidth="1.6" style={legs}>
        <path d="M84 276 L100 112" pathLength={1} />
        <path d="M136 276 L120 112" pathLength={1} />
      </g>
      <g stroke={line} strokeWidth="2.4" style={legs}>
        <path d="M40 276 L80 112" pathLength={1} />
        <path d="M180 276 L140 112" pathLength={1} />
      </g>
      <g stroke={line} strokeWidth="1.4" style={brace}>
        {[[228, 51.7, 168.3], [184, 62.4, 157.6], [146, 71.7, 148.3]].map(([y, x0, x1]) => <path key={y} d={`M${x0} ${y} H${x1}`} pathLength={1} />)}
        <path d="M42 270 L157.6 184 M178 270 L62.4 184" pathLength={1} />
        <path d="M62.4 184 L148.3 146 M157.6 184 L71.7 146" pathLength={1} />
        <path d="M71.7 146 L140 112 M148.3 146 L80 112" pathLength={1} />
      </g>
      <path d="M96 276 L124 248 L96 220 L124 192 L96 164 L122 136 L104 116" stroke={dim} strokeWidth="1" pathLength={1} style={brace} />
      <g stroke={line} strokeWidth="2" style={deck}>
        <path d="M62 112 H158" pathLength={1} />
        <path d="M62 112 V100 H158 V112 M78 100 V112 M94 100 V112 M110 100 V112 M126 100 V112 M142 100 V112" pathLength={1} />
      </g>
      <ellipse cx="110" cy="79" rx="90" ry="60" fill="url(#ew-cabglow)" style={{ opacity: lit ? 1 : 0, transition: "opacity 1.2s ease-out" }} />
      {/* solid cab + roof (they hide the firefly when he passes behind) */}
      <rect x="70" y="58" width="80" height="42" fill="var(--color-void)" style={{ fillOpacity: "var(--p3, 0)" }} />
      <g stroke={line} strokeWidth="2.2" style={cab}>
        <path d="M70 100 V58 H150 V100" pathLength={1} />
        <path d="M76 64 H144 V88 H76 Z M98 64 V88 M122 64 V88" pathLength={1} />
      </g>
      <g style={{ opacity: lit ? 1 : 0, transition: "opacity 0.6s ease-out 0.15s" }}>
        <rect x="77" y="65" width="20" height="22" fill={warm} fillOpacity="0.55" />
        <rect x="99" y="65" width="22" height="22" fill={warm} fillOpacity="0.72" />
        <rect x="123" y="65" width="20" height="22" fill={warm} fillOpacity="0.55" />
      </g>
      <path d="M62 58 L110 30 L158 58 Z" fill="var(--color-void)" style={{ fillOpacity: "var(--p4, 0)" }} />
      <path d="M62 58 L110 30 L158 58 Z" stroke={line} strokeWidth="2.2" pathLength={1} style={roof} />
      <path d="M110 30 V12" stroke={line} strokeWidth="1.8" pathLength={1} style={mast} />
      <circle cx="110" cy="10" r="2.6" fill={lit ? warm : line} style={{ opacity: "var(--p5, 0)", transition: "fill 0.4s" }} />
      {lit && (
        <>
          <circle cx="110" cy="10" r="6" fill="none" stroke={warm} strokeWidth="2" style={{ transformOrigin: "110px 10px", animation: "ew-flash 1.1s ease-out forwards" }} />
          <g style={{ transformOrigin: "110px 10px", animation: "ew-sweep 3.2s linear infinite" }}>
            <path d="M110 10 L200 -8 L200 28 Z" fill="url(#ew-beam)" />
          </g>
        </>
      )}
      <style>{"@keyframes ew-sweep{0%{transform:scaleX(1)}25%{transform:scaleX(0.15)}50%{transform:scaleX(-1)}75%{transform:scaleX(-0.15)}100%{transform:scaleX(1)}}@keyframes ew-flash{from{transform:scale(1);opacity:1}to{transform:scale(9);opacity:0}}"}</style>
    </svg>
  );
});

// ---------------------------------------------------------------- the flight
interface Spark { x: number; y: number; vx: number; vy: number; life: number; r: number }

/**
 * Flies the firefly along the spiral by the shared displayed progress (already paced). Every
 * frame is written straight to the DOM; only the mascot's own small SVG re-renders (wings,
 * blinks). Sweeping right = the near side (in front of the tower), sweeping left = the far side
 * (behind it); the final approach to the beacon is always in front.
 */
const Flight = memo(function Flight({ shown, arrived }: { shown: RefObject<number>; arrived: boolean }) {
  const pathRef = useRef<SVGPathElement>(null);
  const trailRef = useRef<SVGSVGElement>(null);
  const tails = useRef<(SVGPathElement | null)[]>([]);
  const spriteRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctlRef = useRef<FireflyController | null>(null);
  const arrivedRef = useRef(arrived);
  useEffect(() => { arrivedRef.current = arrived; }, [arrived]);
  const [len, setLen] = useState(0);
  useLayoutEffect(() => { setLen(pathRef.current?.getTotalLength() ?? 0); }, []);

  useEffect(() => {
    const path = pathRef.current, cv = canvasRef.current;
    if (!path || !len || !cv) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = STAGE_W * dpr; cv.height = STAGE_H * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    let raf = 0, last = performance.now();
    let sparks: Spark[] = [];
    let tail = 0, depth = 1;
    const att = { bank: 0, turn: 0, squash: 0 };
    const prev = { x: WAYPOINTS[0][0], y: WAYPOINTS[0][1] };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const arrivedNow = arrivedRef.current;
      const u = easeInOut(clamp(shown.current ?? 0, 0, 1));
      const pt = path.getPointAtLength(u * len);
      const t = now / 1000;
      const wob = arrivedNow ? { x: Math.sin(t * 1.3) * 3, y: Math.sin(t * 2.1) * 4 } : { x: Math.sin(t * 6) * 1.2, y: Math.cos(t * 4.5) * 1.5 };
      const x = pt.x + wob.x, y = pt.y + wob.y;
      const vx = x - prev.x, vy = y - prev.y, speed = Math.hypot(vx, vy);
      prev.x = x; prev.y = y;

      // Tail grows while moving, shrinks away when he stops / arrives.
      const wantTail = arrivedNow ? 0 : Math.min(TAIL, u, speed > 0.05 ? TAIL : 0);
      tail += (wantTail - tail) * Math.min(1, dt * 3);
      const wantDepth = arrivedNow || u > 0.9 ? 1 : vx < -0.04 ? -1 : vx > 0.04 ? 1 : depth;
      depth += (wantDepth - depth) * Math.min(1, dt * 5);
      const behind = depth < 0, far = (1 - depth) / 2;

      // Bank into the motion, yaw a little toward the heading (never a spin), stretch with speed.
      const sp = { x: vx / Math.max(dt, 1e-3), y: vy / Math.max(dt, 1e-3) }, cruise = 180, k = Math.min(1, dt * 6);
      const aim = arrivedNow ? { bank: 0, turn: 0, squash: 0 } : {
        bank: clamp((sp.x / cruise) * 26 + (sp.y / cruise) * 6 * Math.sign(sp.x || 1), -32, 32),
        turn: clamp((sp.x / cruise) * 42, -48, 48),
        squash: -clamp((Math.hypot(sp.x, sp.y) / cruise) * 0.07, 0, 0.12),
      };
      att.bank += (aim.bank - att.bank) * k; att.turn += (aim.turn - att.turn) * k; att.squash += (aim.squash - att.squash) * k;
      const ctl = ctlRef.current;
      if (ctl) ctl.override = { ...ctl.override, turn: att.turn, rotation: att.bank, squash: att.squash };

      // DOM writes: sprite position / depth, trail dashes and layer.
      const sprite = spriteRef.current;
      if (sprite) {
        sprite.style.transform = `translate(${(x - SPRITE / 2).toFixed(1)}px, ${(y - SPRITE / 2).toFixed(1)}px) scale(${(1 - far * 0.2).toFixed(3)})`;
        sprite.style.opacity = (1 - far * 0.3).toFixed(3);
        sprite.style.zIndex = behind ? "1" : "4";
      }
      const layer = behind ? "1" : "3";
      if (trailRef.current) { trailRef.current.style.zIndex = layer; trailRef.current.style.opacity = (1 - far * 0.35).toFixed(3); }
      cv.style.zIndex = layer;
      [1, 0.6, 0.25].forEach((f, i) => {
        const el = tails.current[i];
        if (!el) return;
        const l = Math.max(0, tail * f);
        el.setAttribute("stroke-dasharray", `${l.toFixed(4)} 2`);
        el.setAttribute("stroke-dashoffset", (-(u - l)).toFixed(4));
      });

      // Sparkles on a canvas (cheap; no DOM nodes).
      if (speed > 0.2 && Math.random() < 0.5) sparks.push({ x: x + (Math.random() - 0.5) * 4, y: y + SPRITE * 0.25, vx: (Math.random() - 0.5) * 10, vy: 8 + Math.random() * 12, life: 1, r: 0.6 + Math.random() * 1.1 });
      g.clearRect(0, 0, STAGE_W, STAGE_H);
      g.fillStyle = "#fff3a6";
      sparks = sparks.filter((s) => {
        s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 20 * dt; s.life -= dt * 1.4;
        if (s.life <= 0) return false;
        g.globalAlpha = s.life;
        g.beginPath(); g.arc(s.x, s.y, s.r * s.life, 0, Math.PI * 2); g.fill();
        return true;
      }).slice(-40);
      g.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [len, shown]);

  const tailBase = { d: FLIGHT, fill: "none", strokeLinecap: "round" as const, pathLength: 1, strokeDasharray: "0 2" };
  return (
    <>
      <svg ref={trailRef} className="pointer-events-none absolute inset-0" width={STAGE_W} height={STAGE_H} style={{ overflow: "visible", zIndex: 3 }}>
        <defs><filter id="ew-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" /></filter></defs>
        <path ref={pathRef} d={FLIGHT} fill="none" stroke="none" />
        <path ref={(el) => { tails.current[0] = el; }} {...tailBase} stroke="#ffd93b" strokeOpacity="0.18" strokeWidth="5" filter="url(#ew-soft)" />
        <path ref={(el) => { tails.current[1] = el; }} {...tailBase} stroke="#ffe86a" strokeOpacity="0.35" strokeWidth="2" />
        <path ref={(el) => { tails.current[2] = el; }} {...tailBase} stroke="#fff3a6" strokeOpacity="0.85" strokeWidth="1.2" />
      </svg>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" style={{ width: STAGE_W, height: STAGE_H, zIndex: 3 }} />
      <div ref={spriteRef} className="pointer-events-none absolute left-0 top-0" style={{ width: SPRITE, zIndex: 4, willChange: "transform", transformOrigin: "center" }}>
        <MascotSprite onController={(c) => { ctlRef.current = c; }} />
      </div>
    </>
  );
});

/** The standard mascot; only this small component re-renders per frame (wing flaps, blinks). */
function MascotSprite({ onController }: { onController: (c: FireflyController) => void }) {
  const ctl = useFirefly({ mood: "happy" });
  useEffect(() => { onController(ctl); }, [ctl, onController]);
  return <Firefly pose={ctl.pose} size={SPRITE} />;
}
