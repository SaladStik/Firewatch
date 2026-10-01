/** Small overlays: nav controls, hover tooltip, boot screen. */
import gsap from "gsap";
import { Home, Minus, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { HexIcon, IconButton } from "./primitives";

export function NavControls({ engine }: { engine: Engine | null }) {
  return (
    <div className="pointer-events-auto flex flex-col gap-1">
      <IconButton title="Zoom in" onClick={() => engine?.scene.zoomBy(0.5)}><Plus size={15} /></IconButton>
      <IconButton title="Zoom out" onClick={() => engine?.scene.zoomBy(2)}><Minus size={15} /></IconButton>
      <IconButton title="Whole province" onClick={() => engine?.scene.resetView()}><Home size={14} /></IconButton>
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
        <div className="border border-line bg-panel px-2 py-1 text-[10.5px]">
          <div className="flex items-center gap-1.5">
            <HexIcon size={10} color={status.line ?? type.line} />
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
  useEffect(() => {
    if (boot.done && ref.current) {
      gsap.to(ref.current, { opacity: 0, duration: 0.8, delay: 0.3, ease: "power2.out", onComplete: () => { if (ref.current) ref.current.style.display = "none"; } });
    }
  }, [boot.done]);
  return (
    <div ref={ref} className="absolute inset-0 z-50 flex items-center justify-center bg-void">
      <div className="flex flex-col items-center gap-5">
        <div className="relative animate-pulse">
          <HexIcon size={64} color="var(--color-phos)" className="drop-shadow-[0_0_14px_rgba(46,234,124,.7)]" />
        </div>
        <div className="text-[18px] font-bold tracking-[0.3em] text-ink glow-text">EMBER<span className="text-phos">//</span>GRID</div>
        <div className="text-[11px] tracking-[0.2em] text-ink-mute">
          {boot.error ? <span className="text-fire">{boot.error}</span> : <>{boot.stage.toUpperCase()}<span className="animate-pulse">_</span></>}
        </div>
      </div>
    </div>
  );
}
