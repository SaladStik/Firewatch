/**
 * EMBER//WATCH loading screen: a fire lookout tower that draws itself as loading
 * progresses (legs → bracing → platform → cab → roof → antenna), whose cab lights up
 * and beacon sweeps when it's done, with the firefly orbiting the tower in 3D:
 * he goes behind the cab (hidden by it) and in front of the lattice, turning to face
 * where he's flying and shrinking / dimming with distance.
 *
 * Pure presentation: give it `progress` (0..1), a `stage` label and optionally an
 * `error`. Used by the app's boot overlay (ui/Overlays.tsx) and the test page
 * (/loading.html).
 */
import { useEffect, useRef, useState } from "react";
import { FireflyAgent, useFirefly } from "../../mascot/firefly";

export interface LoadingScreenProps {
  /** 0..1 */
  progress: number;
  stage?: string;
  error?: string | null;
  /** Show the firefly orbiting the tower. */
  firefly?: boolean;
  /** Orbit speed multiplier (1 = one lap every ~6 s). */
  orbitSpeed?: number;
}

/** Tower size (px) and the firefly's size relative to it. */
const TOWER_W = 220, TOWER_H = 286;
const FIREFLY_SIZE = 74;

/** Each part of the tower draws during its own slice of the progress bar. */
const PARTS: { from: number; to: number }[] = [
  { from: 0.0, to: 0.38 }, // legs
  { from: 0.22, to: 0.62 }, // bracing
  { from: 0.58, to: 0.72 }, // platform + railing
  { from: 0.68, to: 0.86 }, // cab
  { from: 0.84, to: 0.95 }, // roof
  { from: 0.93, to: 1.0 }, // antenna
];
const part = (p: number, i: number) => Math.min(1, Math.max(0, (p - PARTS[i].from) / (PARTS[i].to - PARTS[i].from)));

export function LoadingScreen({ progress, stage = "loading", error = null, firefly = true, orbitSpeed = 1 }: LoadingScreenProps) {
  // Ease the displayed progress toward the real one so the drawing never jumps.
  const [shown, setShown] = useState(0);
  const target = useRef(progress);
  target.current = progress;
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setShown((s) => {
        const t = target.current;
        return t < s ? t : s + (t - s) * Math.min(1, dt * 5);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const done = shown > 0.995 && !error;

  return (
    <div className="flex flex-col items-center gap-5 select-none">
      <div className="relative" style={{ width: TOWER_W + 160, height: TOWER_H + 20 }}>
        <div className="absolute" style={{ left: 80, top: 10, width: TOWER_W, height: TOWER_H, zIndex: 2 }}>
          <Tower p={shown} done={done} />
        </div>
        {firefly && <OrbitingFirefly speed={orbitSpeed} />}
      </div>
      <div className="text-[20px] font-bold tracking-[0.32em] text-ink glow-text">
        EMBER<span className="text-phos">//</span>WATCH
      </div>
      <div className="h-4 text-[11px] tracking-[0.2em] text-ink-mute">
        {error ? <span className="text-fire">{error}</span> : <>{stage.toUpperCase()}<span className="animate-pulse">_</span></>}
      </div>
      {!error && (
        <div className="h-[3px] w-64 overflow-hidden border border-line">
          <div className="h-full bg-phos" style={{ width: `${Math.round(shown * 100)}%`, boxShadow: "0 0 8px var(--color-phos)" }} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the tower
function Tower({ p, done }: { p: number; done: boolean }) {
  const line = "var(--color-phos)";
  const dim = "color-mix(in srgb, var(--color-phos) 45%, transparent)";
  const warm = "#ffb347";
  // Draw-on: every path has pathLength 1; dashoffset 1 → 0 reveals it.
  const draw = (i: number) => ({ strokeDasharray: 1, strokeDashoffset: 1 - part(p, i) });
  const legs = draw(0), brace = draw(1), deck = draw(2), cab = draw(3), roof = draw(4), mast = draw(5);
  const cabFill = part(p, 3); // the cab turns solid as it's drawn (so it hides the firefly behind it)

  return (
    <svg viewBox="0 0 220 286" width="100%" height="100%" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: "visible", filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--color-phos) 55%, transparent))" }}>
      <defs>
        <radialGradient id="ew-beam" cx="0" cy="0.5" r="1">
          <stop offset="0" stopColor={warm} stopOpacity="0.55" />
          <stop offset="1" stopColor={warm} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ground */}
      <path d="M10 276 H210" stroke={dim} strokeWidth="1.2" pathLength={1} style={draw(0)} />

      {/* back legs (fainter, for depth) */}
      <g stroke={dim} strokeWidth="1.6" style={legs}>
        <path d="M84 276 L100 112" pathLength={1} />
        <path d="M136 276 L120 112" pathLength={1} />
      </g>
      {/* front legs */}
      <g stroke={line} strokeWidth="2.4" style={legs}>
        <path d="M40 276 L80 112" pathLength={1} />
        <path d="M180 276 L140 112" pathLength={1} />
      </g>

      {/* bracing: horizontal ties + X braces between them (front face) */}
      <g stroke={line} strokeWidth="1.4" style={brace}>
        {[
          [228, 51.7, 168.3], [184, 62.4, 157.6], [146, 71.7, 148.3],
        ].map(([y, x0, x1]) => <path key={y} d={`M${x0} ${y} H${x1}`} pathLength={1} />)}
        <path d="M42 270 L157.6 184 M178 270 L62.4 184" pathLength={1} />
        <path d="M62.4 184 L148.3 146 M157.6 184 L71.7 146" pathLength={1} />
        <path d="M71.7 146 L140 112 M148.3 146 L80 112" pathLength={1} />
      </g>

      {/* stairs zig-zag up the middle (back) */}
      <path d="M96 276 L124 248 L96 220 L124 192 L96 164 L122 136 L104 116" stroke={dim} strokeWidth="1" pathLength={1} style={brace} />

      {/* platform + railing */}
      <g stroke={line} strokeWidth="2" style={deck}>
        <path d="M62 112 H158" pathLength={1} />
        <path d="M62 112 V100 H158 V112 M78 100 V112 M94 100 V112 M110 100 V112 M126 100 V112 M142 100 V112" pathLength={1} />
      </g>

      {/* cab: solid (hides the firefly behind it), with windows */}
      <rect x="70" y="58" width="80" height="42" fill="var(--color-void)" fillOpacity={cabFill} />
      <g stroke={line} strokeWidth="2.2" style={cab}>
        <path d="M70 100 V58 H150 V100" pathLength={1} />
        <path d="M76 64 H144 V88 H76 Z M98 64 V88 M122 64 V88" pathLength={1} />
      </g>
      {/* lit windows when loading completes */}
      <g style={{ opacity: done ? 1 : 0, transition: "opacity 0.6s ease-out" }}>
        <rect x="77" y="65" width="20" height="22" fill={warm} fillOpacity="0.55" />
        <rect x="99" y="65" width="22" height="22" fill={warm} fillOpacity="0.7" />
        <rect x="123" y="65" width="20" height="22" fill={warm} fillOpacity="0.55" />
      </g>

      {/* roof (solid too) */}
      <path d="M62 58 L110 30 L158 58 Z" fill="var(--color-void)" fillOpacity={part(p, 4)} />
      <path d="M62 58 L110 30 L158 58 Z" stroke={line} strokeWidth="2.2" pathLength={1} style={roof} />

      {/* antenna + beacon */}
      <path d="M110 30 V12" stroke={line} strokeWidth="1.8" pathLength={1} style={mast} />
      <circle cx="110" cy="10" r="2.6" fill={done ? warm : line} style={{ opacity: part(p, 5), transition: "fill 0.4s" }} />
      {done && (
        <g style={{ transformOrigin: "110px 10px", animation: "ew-sweep 3.2s linear infinite" }}>
          <path d="M110 10 L200 -8 L200 28 Z" fill="url(#ew-beam)" />
        </g>
      )}
      <style>{"@keyframes ew-sweep{0%{transform:scaleX(1)}25%{transform:scaleX(0.15)}50%{transform:scaleX(-1)}75%{transform:scaleX(-0.15)}100%{transform:scaleX(1)}}"}</style>
    </svg>
  );
}

// ---------------------------------------------------------------- the firefly
/**
 * Orbits the tower on a tilted ellipse around the cab. Depth = sin(angle): positive is in
 * front. He's layered above the tower (z 3) in front and below it (z 1) behind, so the solid
 * cab hides him while the open lattice lets him show through; he faces his direction of
 * travel (turn 0 = facing you at the front, 180 = back to you behind) and shrinks / dims with
 * distance.
 */
function OrbitingFirefly({ speed }: { speed: number }) {
  const ctl = useFirefly({ x: 0, y: 0, mood: "happy" });
  const [front, setFront] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = ((now - t0) / 1000) * speed * ((Math.PI * 2) / 6);
      const depth = Math.sin(t);
      // Centre of the orbit: the cab (tower box is at 80,10 inside a 380-wide stage).
      const cx = 80 + 110, cy = 10 + 74;
      const x = cx + Math.cos(t) * 150;
      const y = cy + depth * 26 + Math.sin(t * 2) * 10; // tilted orbit + a gentle figure-eight bob
      ctl.teleport(x, y);
      // Face the direction of travel; bank into the curve.
      ctl.override = { ...ctl.override, turn: ((t * 180) / Math.PI - 90 + 360) % 360, scale: 0.78 + 0.22 * (depth + 1) / 2, rotation: -Math.cos(t) * 8 };
      setFront((f) => (f !== depth > 0 ? depth > 0 : f));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ctl, speed]);
  return (
    <div ref={host} className="absolute inset-0" style={{ zIndex: front ? 3 : 1, opacity: front ? 1 : 0.75, transition: "opacity 0.25s" }}>
      <FireflyAgent controller={ctl} size={FIREFLY_SIZE} />
    </div>
  );
}
