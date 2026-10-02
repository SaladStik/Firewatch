/** Small overlays: nav controls, north arrow, hover tooltip, boot screen. */
import { LoadingScreen } from "./loading/LoadingScreen";
import gsap from "gsap";
import { Home, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { IconButton, Swatch } from "./primitives";

/** The direction the camera looks, as a compass point. `heading` is from Scene (camera south of target = 0). */
const POINTS = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];
function facingName(heading: number) {
  const facing = ((-heading % 360) + 360) % 360; // degrees clockwise from north
  return POINTS[Math.round(facing / 45) % 8];
}

/**
 * North arrow. Reads the camera heading every frame and rotates the dial directly (no React
 * re-renders), eased along the shortest way round so it glides instead of stepping. Fixed size,
 * wide enough for the longest label ("Northwest"): the label changes text, never the panel's width.
 */
export function CompassRose({ engine }: { engine: Engine | null }) {
  const dial = useRef<SVGSVGElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0, shown = engine?.scene.heading ?? 0, last = performance.now(), name = "";
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const target = engine?.scene?.heading;
      if (target !== undefined) {
        const d = ((target - shown + 540) % 360) - 180; // shortest way round
        shown += d * Math.min(1, dt * 12);
        if (dial.current) dial.current.style.transform = `rotate(${shown.toFixed(2)}deg)`;
        const n = facingName(target);
        if (n !== name && label.current) { name = n; label.current.textContent = n; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);
  return (
    <div className="panel pointer-events-none flex w-[100px] flex-col items-center gap-1 px-2 py-2" title="Compass" data-tour="compass">
      <div className="relative h-14 w-14">
        <svg ref={dial} viewBox="0 0 64 64" className="h-14 w-14" style={{ willChange: "transform" }} aria-hidden>
          <circle cx="32" cy="32" r="30" fill="var(--color-panel)" stroke="var(--color-line)" strokeWidth="1.5" />
          <path d="M32 8 L37 32 L32 28 L27 32 Z" fill="var(--color-fire)" />
          <path d="M32 56 L27 32 L32 36 L37 32 Z" fill="var(--color-ink-mute)" />
          <text x="32" y="18" textAnchor="middle" fontSize="8" fontWeight="700" fill="var(--color-fire)">N</text>
          <text x="32" y="54" textAnchor="middle" fontSize="7" fill="var(--color-ink-mute)">S</text>
          <text x="50" y="35" textAnchor="middle" fontSize="7" fill="var(--color-ink-mute)">E</text>
          <text x="14" y="35" textAnchor="middle" fontSize="7" fill="var(--color-ink-mute)">W</text>
          <circle cx="32" cy="32" r="2.5" fill="var(--color-ink)" />
        </svg>
      </div>
      <span ref={label} className="label-xs block w-full whitespace-nowrap text-center">North</span>
    </div>
  );
}

export function NavControls({ engine }: { engine: Engine | null }) {
  return (
    <div className="pointer-events-auto flex flex-col items-end gap-1" data-tour="nav">
      <CompassRose engine={engine} />
      <div className="flex flex-col gap-1">
        <IconButton title="Zoom in" onClick={() => engine?.scene.zoomBy(0.5)}><Plus size={15} /></IconButton>
        <IconButton title="Zoom out" onClick={() => engine?.scene.zoomBy(2)}><Minus size={15} /></IconButton>
        <IconButton title="Whole province" onClick={() => engine?.scene.resetView()}><Home size={14} /></IconButton>
      </div>
    </div>
  );
}

export function HoverTip() {
  const n = useStore(app, (s) => s.hover);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (ref.current) ref.current.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  const status = n ? NODE_STATUSES[n.status] : null;
  const type = n ? NODE_TYPES[n.land] : null;
  return (
    <div ref={ref} className="pointer-events-none fixed top-0 left-0 z-30" style={{ display: n ? "block" : "none" }}>
      {n && type && status && (
        <div className="border border-line bg-panel px-2 py-1 text-[10.5px] shadow-sm">
          <div className="flex items-center gap-1.5">
            <Swatch color={status.line ?? type.line} />
            <span className="text-ink">{type.label}</span>
            {n.status !== NodeStatus.Normal && <span style={{ color: status.line }}>· {status.label}</span>}
          </div>
          <div className="tabular-nums text-ink-mute">{Math.round(n.elevation)} m · risk {Math.round(n.risk * 100)}</div>
        </div>
      )}
    </div>
  );
}

export function BootScreen() {
  const boot = useStore(app, (s) => s.boot);
  const ref = useRef<HTMLDivElement>(null);
  // Fade out only after the loading animation's finale has played (it trails the real progress
  // on purpose so it stays smooth), so the firefly always gets to light the tower.
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (boot.done && finished && ref.current) {
      gsap.to(ref.current, { opacity: 0, duration: 0.6, ease: "power2.out", onComplete: () => { if (ref.current) ref.current.style.display = "none"; } });
    }
  }, [boot.done, finished]);
  return (
    <div ref={ref} className="absolute inset-0 z-50 flex items-center justify-center bg-void">
      {/* FIRE//WATCH tower + firefly (ui/loading/LoadingScreen.tsx; test page: /loading.html) */}
      <LoadingScreen progress={boot.done ? 1 : boot.progress ?? 0} stage={boot.stage} error={boot.error} onComplete={() => setFinished(true)} />
    </div>
  );
}
