/**
 * FIRE//WATCH loading screen.
 *
 * A fire lookout tower draws itself as loading progresses (legs → bracing → platform → cab →
 * roof → antenna). A flat 2D firefly flies up from the ground in a swooping arc around the
 * tower, Disney-castle style, leaving a glowing trail and falling sparkles; his place on the
 * arc follows the loading progress. When loading finishes he reaches the top and lights the
 * tower: a flash at the beacon, the cab windows glow and the beacon sweeps. A frame beside it
 * ticks off what's loading (terrain, roads and towns, live fires, weather, fire danger…).
 *
 * Pure presentation: give it `progress` (0..1), a `stage` label and optionally an `error`.
 * Used by the app's boot overlay (ui/Overlays.tsx) and the test page (/loading.html).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Firefly, useFirefly } from "../../mascot/firefly";

export interface LoadingScreenProps {
  /** 0..1 */
  progress: number;
  stage?: string;
  error?: string | null;
  /** Show the firefly and his trail. */
  firefly?: boolean;
}

/** What's loading, and the progress at which each is done (matches the app's boot sequence). */
export const LOAD_STEPS: { label: string; source: string; doneAt: number }[] = [
  { label: "Elevation & land cover", source: "AWS Terrain · ESA WorldCover", doneAt: 0.4 },
  { label: "Rivers, roads, rail & towns", source: "OpenStreetMap", doneAt: 0.8 },
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
 * The flight: a smooth, widening-then-narrowing spiral up around the tower, ending beside the
 * beacon. Waypoints are joined with a Catmull-Rom spline, so there are no hard turns.
 */
const WAYPOINTS: [number, number][] = [[30, 312], [130, 300], [270, 268], [300, 226], [230, 196], [110, 176], [72, 140], [140, 112], [262, 96], [276, 64], [228, 36], [206, 26]];
const FLIGHT = catmullRom(WAYPOINTS);
/** Length of the fading comet tail behind him, as a share of the whole flight. */
const TAIL = 0.14;

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

export function LoadingScreen({ progress, stage = "loading", error = null, firefly = true }: LoadingScreenProps) {
  // Ease the displayed progress toward the real one so the drawing and the flight never jump.
  const [shown, setShown] = useState(0);
  const target = useRef(progress);
  useEffect(() => { target.current = progress; }, [progress]);
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setShown((s) => {
        const t = target.current;
        return t < s ? t : Math.min(t, s + (t - s) * Math.min(1, dt * 4) + dt * 0.02);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const done = shown > 0.995 && !error;

  return (
    <div className="flex select-none flex-col items-center gap-6 md:flex-row md:items-center md:gap-10">
      <div className="flex flex-col items-center gap-4">
        <div className="relative" style={{ width: STAGE_W, height: STAGE_H }}>
          <div className="absolute" style={{ left: TOWER_X, top: TOWER_Y, width: 220, height: 286 }}>
            <Tower p={shown} lit={done} />
          </div>
          {firefly && <Flight p={shown} arrived={done} />}
        </div>
        <div className="text-[20px] font-bold tracking-[0.32em] text-ink glow-text">
          FIRE<span className="text-phos">//</span>WATCH
        </div>
        <div className="h-[3px] w-64 overflow-hidden border border-line">
          {!error && <div className="h-full bg-phos" style={{ width: `${Math.round(shown * 100)}%`, boxShadow: "0 0 8px var(--color-phos)" }} />}
        </div>
      </div>
      <LoadFrame p={shown} stage={stage} error={error} />
    </div>
  );
}

// ---------------------------------------------------------------- the loading frame
function LoadFrame({ p, stage, error }: { p: number; stage: string; error: string | null }) {
  const active = LOAD_STEPS.findIndex((s) => p < s.doneAt - 1e-3);
  return (
    <div className="panel w-[300px] p-3 text-[11px]">
      <div className="mb-2 flex items-center justify-between border-b border-line pb-2">
        <span className="label-xs text-phos">SYSTEM CHECK</span>
        <span className="tabular-nums text-ink-mute">{Math.round(p * 100)}%</span>
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
                <span className={isDone ? "text-ink" : isActive ? "text-ink" : "text-ink-mute"}>{s.label}</span>
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
}

// ---------------------------------------------------------------- the tower
function Tower({ p, lit }: { p: number; lit: boolean }) {
  const line = "var(--color-phos)";
  const dim = "color-mix(in srgb, var(--color-phos) 45%, transparent)";
  const warm = "#ffb347";
  const draw = (i: number) => ({ strokeDasharray: 1, strokeDashoffset: 1 - part(p, i) });
  const legs = draw(0), brace = draw(1), deck = draw(2), cab = draw(3), roof = draw(4), mast = draw(5);

  return (
    <svg viewBox="0 0 220 286" width="100%" height="100%" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: "visible", filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--color-phos) 55%, transparent))" }}>
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
      {/* warm glow around the cab once it's lit */}
      <ellipse cx="110" cy="79" rx="90" ry="60" fill="url(#ew-cabglow)" style={{ opacity: lit ? 1 : 0, transition: "opacity 1.2s ease-out" }} />
      <rect x="70" y="58" width="80" height="42" fill="var(--color-void)" fillOpacity={part(p, 3)} />
      <g stroke={line} strokeWidth="2.2" style={cab}>
        <path d="M70 100 V58 H150 V100" pathLength={1} />
        <path d="M76 64 H144 V88 H76 Z M98 64 V88 M122 64 V88" pathLength={1} />
      </g>
      <g style={{ opacity: lit ? 1 : 0, transition: "opacity 0.6s ease-out 0.15s" }}>
        <rect x="77" y="65" width="20" height="22" fill={warm} fillOpacity="0.55" />
        <rect x="99" y="65" width="22" height="22" fill={warm} fillOpacity="0.72" />
        <rect x="123" y="65" width="20" height="22" fill={warm} fillOpacity="0.55" />
      </g>
      <path d="M62 58 L110 30 L158 58 Z" fill="var(--color-void)" fillOpacity={part(p, 4)} />
      <path d="M62 58 L110 30 L158 58 Z" stroke={line} strokeWidth="2.2" pathLength={1} style={roof} />
      <path d="M110 30 V12" stroke={line} strokeWidth="1.8" pathLength={1} style={mast} />
      <circle cx="110" cy="10" r="2.6" fill={lit ? warm : line} style={{ opacity: part(p, 5), transition: "fill 0.4s" }} />
      {lit && (
        <>
          {/* the moment he lights it: a flash ring from the beacon */}
          <circle cx="110" cy="10" r="6" fill="none" stroke={warm} strokeWidth="2" style={{ transformOrigin: "110px 10px", animation: "ew-flash 1.1s ease-out forwards" }} />
          <g style={{ transformOrigin: "110px 10px", animation: "ew-sweep 3.2s linear infinite" }}>
            <path d="M110 10 L200 -8 L200 28 Z" fill="url(#ew-beam)" />
          </g>
        </>
      )}
      <style>{"@keyframes ew-sweep{0%{transform:scaleX(1)}25%{transform:scaleX(0.15)}50%{transform:scaleX(-1)}75%{transform:scaleX(-0.15)}100%{transform:scaleX(1)}}@keyframes ew-flash{from{transform:scale(1);opacity:1}to{transform:scale(9);opacity:0}}"}</style>
    </svg>
  );
}

// ---------------------------------------------------------------- the flight
interface Spark { x: number; y: number; vx: number; vy: number; life: number; r: number }

/**
 * The standard firefly (mascot/firefly), small and facing forward — no 3D turning — flown along
 * the spiral by progress. Behind him only a short comet tail that fades out (it doesn't stay
 * drawn), plus a few falling sparkles. Once loading is done he hovers beside the beacon and the
 * tail shrinks away.
 */
function Flight({ p, arrived }: { p: number; arrived: boolean }) {
  const ctl = useFirefly({ mood: "happy" }); // wing flaps, blinks, lantern pulse
  const pathRef = useRef<SVGPathElement>(null);
  const [len, setLen] = useState(0);
  useLayoutEffect(() => { setLen(pathRef.current?.getTotalLength() ?? 0); }, []);
  const [view, setView] = useState<{ x: number; y: number; tail: number; u: number; depth: number; sparks: Spark[] }>({ x: 30, y: 312, tail: 0, u: 0, depth: 1, sparks: [] });
  const progress = useRef(p);
  const arrivedRef = useRef(arrived);
  useEffect(() => { progress.current = p; arrivedRef.current = arrived; }, [p, arrived]);

  useEffect(() => {
    let raf = 0, last = performance.now();
    let sparks: Spark[] = [];
    let tail = 0;
    // Depth along the spiral: sweeping right = the near side (in front of the tower), sweeping
    // left = the far side (behind it). Eased so he doesn't flicker at the turns; the final
    // approach to the beacon is always in front.
    let depth = 1;
    const att = { bank: 0, turn: 0, squash: 0 };
    const prev = { x: 30, y: 312 };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const path = pathRef.current;
      let x = prev.x, y = prev.y, u = 0;
      if (path && len) {
        u = easeInOut(Math.min(1, progress.current));
        const pt = path.getPointAtLength(u * len);
        const t = now / 1000;
        const wob = arrivedRef.current ? { x: Math.sin(t * 1.3) * 3, y: Math.sin(t * 2.1) * 4 } : { x: Math.sin(t * 6) * 1.2, y: Math.cos(t * 4.5) * 1.5 };
        x = pt.x + wob.x; y = pt.y + wob.y;
        const vx = x - prev.x, vy = y - prev.y, speed = Math.hypot(vx, vy);
        prev.x = x; prev.y = y;
        // Tail grows while he's moving, shrinks away when he stops (and after he arrives).
        const want = arrivedRef.current ? 0 : Math.min(TAIL, u, speed > 0.05 ? TAIL : 0);
        tail += (want - tail) * Math.min(1, dt * 3);
        const wantDepth = arrivedRef.current || u > 0.9 ? 1 : vx < -0.04 ? -1 : vx > 0.04 ? 1 : depth;
        depth += (wantDepth - depth) * Math.min(1, dt * 5);
        // Fly like a creature, not a sticker: bank into the motion, yaw a little toward where he's
        // heading (never a full spin), pitch with climb / dive, stretch with speed. Low-passed so
        // it flows through the curves.
        const sp = dt > 0 ? { x: vx / dt, y: vy / dt } : { x: 0, y: 0 };
        const cruise = 180; // px/s, typical speed along the spiral
        const k = Math.min(1, dt * 6);
        const flying = !arrivedRef.current;
        const aim = {
          bank: flying ? clamp((sp.x / cruise) * 26 + (sp.y / cruise) * 6 * Math.sign(sp.x || 1), -32, 32) : 0,
          turn: flying ? clamp((sp.x / cruise) * 42, -48, 48) : 0,
          squash: flying ? -clamp((Math.hypot(sp.x, sp.y) / cruise) * 0.07, 0, 0.12) : 0,
        };
        att.bank += (aim.bank - att.bank) * k;
        att.turn += (aim.turn - att.turn) * k;
        att.squash += (aim.squash - att.squash) * k;
        ctl.override = { ...ctl.override, turn: att.turn, rotation: att.bank, squash: att.squash };
        if (speed > 0.2 && Math.random() < 0.5) {
          sparks.push({ x: x + (Math.random() - 0.5) * 4, y: y + SPRITE * 0.25, vx: (Math.random() - 0.5) * 10, vy: 8 + Math.random() * 12, life: 1, r: 0.6 + Math.random() * 1.1 });
        }
      }
      sparks = sparks
        .map((s) => ({ ...s, x: s.x + s.vx * dt, y: s.y + s.vy * dt, vy: s.vy + 20 * dt, life: s.life - dt * 1.4 }))
        .filter((s) => s.life > 0)
        .slice(-40);
      setView({ x, y, tail, u, depth, sparks });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [len, ctl]);

  // Comet tail: three stacked dashes ending at his position, longest = faintest.
  const dash = (k: number) => {
    const l = Math.max(0, view.tail * k);
    return { strokeDasharray: `${l} 2`, strokeDashoffset: -(view.u - l) };
  };

  // Behind the tower (layer 1, under the tower's layer 2) he's a touch smaller and dimmer.
  const behind = view.depth < 0;
  const far = (1 - view.depth) / 2; // 0 = near side, 1 = far side
  const layer = behind ? 1 : 3;
  return (
    <>
      <svg className="pointer-events-none absolute inset-0" width={STAGE_W} height={STAGE_H} style={{ overflow: "visible", zIndex: layer, opacity: 1 - far * 0.35 }}>
        <defs><filter id="ew-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" /></filter></defs>
        <path ref={pathRef} d={FLIGHT} fill="none" stroke="none" pathLength={1} />
        <path d={FLIGHT} fill="none" stroke="#ffd93b" strokeOpacity="0.18" strokeWidth="5" strokeLinecap="round" filter="url(#ew-soft)" pathLength={1} style={dash(1)} />
        <path d={FLIGHT} fill="none" stroke="#ffe86a" strokeOpacity="0.35" strokeWidth="2" strokeLinecap="round" pathLength={1} style={dash(0.6)} />
        <path d={FLIGHT} fill="none" stroke="#fff3a6" strokeOpacity="0.85" strokeWidth="1.2" strokeLinecap="round" pathLength={1} style={dash(0.25)} />
        {view.sparks.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.r * s.life} fill="#fff3a6" opacity={s.life} />)}
      </svg>
      <div className="pointer-events-none absolute" style={{ left: view.x - SPRITE / 2, top: view.y - SPRITE / 2, width: SPRITE, zIndex: behind ? 1 : 4, transform: `scale(${1 - far * 0.2})`, opacity: 1 - far * 0.3 }}>
        <Firefly pose={ctl.pose} size={SPRITE} />
      </div>
    </>
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
