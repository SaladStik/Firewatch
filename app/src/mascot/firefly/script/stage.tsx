/**
 * The Firefly stage: one fixed, click-through overlay layer (created on first use)
 * that hosts a single shared mascot on ANY page. Scripts play here, including
 * tutorial spotlights (dimmed screen + lantern beam + click to continue).
 *
 *   import { playScript } from "./mascot/firefly/script";
 *   const run = playScript(MY_TOUR);   // run.done resolves at the end; run.stop() cancels
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_CONFIG } from "../config";
import { FireflyController } from "../controller";
import { FireflyAgent } from "../FireflyAgent";
import type { FireflyConfig } from "../types";
import { resolveArea, viewportMin } from "./anchors";
import { runScript } from "./player";
import type { Area, FireflyScript, ScriptStep } from "./types";

interface Spotlight { area: Area; shape: "rect" | "ellipse" }

interface StageState {
  visible: boolean;
  /** Size as a fraction of min(viewport w, h). */
  size: number;
  config: FireflyConfig;
  spotlight: Spotlight | null;
  /** Waiting for the viewer to click through. */
  awaitingClick: boolean;
}

/** FireflyAgent's SVG frame (see Firefly.tsx VIEW): width 210 units, body centre 92 units from the top. */
const VIEW_W = 210, CENTRE_FROM_TOP = 92;

class Stage {
  readonly controller = new FireflyController({ x: innerWidth / 2, y: innerHeight / 2 });
  private state: StageState = { visible: false, size: 0.11, config: DEFAULT_CONFIG, spotlight: null, awaitingClick: false };
  private listeners = new Set<() => void>();
  private current: AbortController | null = null;
  private clickResolve: (() => void) | null = null;
  private aim = 0;

  constructor() {
    // While a spotlight is up, turn so the lantern (his tail) points at it.
    this.controller.subscribe(() => {
      const s = this.state.spotlight;
      const ctl = this.controller;
      if (!s) {
        if ("rotation" in ctl.override) { const { rotation: _r, ...rest } = ctl.override; ctl.override = rest; }
        this.aim = ctl.pose.rotation;
        return;
      }
      const b = resolveArea(s.area);
      const c = this.centrePx();
      const dx = (b.x0 + b.x1) / 2 - c.x, dy = (b.y0 + b.y1) / 2 - c.y;
      const target = (Math.atan2(-dx, dy) * 180) / Math.PI;
      let d = target - this.aim;
      d = ((d + 540) % 360) - 180; // shortest way round
      this.aim += d * 0.12;
      ctl.override = { ...ctl.override, rotation: this.aim };
    });
  }

  get = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  private set(patch: Partial<StageState>) {
    this.state = { ...this.state, ...patch };
    if (patch.visible !== undefined) {
      if (patch.visible) this.controller.start();
      else this.controller.stop();
    }
    this.listeners.forEach((f) => f());
  }

  setVisible(visible: boolean) { this.set({ visible }); }
  setSize(size: number) { this.set({ size }); }
  setConfig(config: FireflyConfig) { this.set({ config }); }
  setSpotlight(spotlight: Spotlight | null) { this.set({ spotlight }); }

  /** Resolves on the viewer's next click / Enter / Space / → (or abort). */
  waitForClick(signal?: AbortSignal) {
    return new Promise<void>((done) => {
      const finish = () => {
        removeEventListener("keydown", onKey);
        this.clickResolve = null;
        this.set({ awaitingClick: false });
        done();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") { e.preventDefault(); finish(); }
      };
      addEventListener("keydown", onKey);
      signal?.addEventListener("abort", finish, { once: true });
      this.clickResolve = finish;
      this.set({ awaitingClick: true });
    });
  }
  clickThrough = () => this.clickResolve?.();

  /** Mascot size in px right now. */
  sizePx() { return Math.round(this.state.size * viewportMin()); }

  /** Screen position of his body centre (accounts for the SVG frame + hover bob). */
  centrePx() {
    const size = this.sizePx(), p = this.controller.pose;
    return { x: p.x, y: p.y - size / 2 + (CENTRE_FROM_TOP / VIEW_W) * size + (p.hover * size) / VIEW_W };
  }

  /** Screen position of the lantern (tail light), following his rotation. */
  lanternPx() {
    const size = this.sizePx(), c = this.centrePx(), p = this.controller.pose, cfg = this.state.config;
    const L = cfg.bodyRadius * (0.9 + cfg.lanternSize * 0.95) * (size / VIEW_W) * p.scale;
    const th = (p.rotation * Math.PI) / 180;
    return { x: c.x - Math.sin(th) * L, y: c.y + Math.cos(th) * L };
  }

  /** Play a script; any script already playing is stopped first. */
  play(script: FireflyScript, opts: { onStep?: (i: number, s: ScriptStep) => void; hideAtEnd?: boolean; from?: number } = {}) {
    this.current?.abort();
    const ac = new AbortController();
    this.current = ac;
    this.set({ size: script.size });
    const done = runScript(this.controller, script, {
      signal: ac.signal,
      onStep: opts.onStep,
      setVisible: (v) => this.setVisible(v),
      setSpotlight: (s) => this.setSpotlight(s),
      waitForClick: (sig) => this.waitForClick(sig),
      sizePx: () => this.sizePx(),
    }, opts.from ?? 0).then(() => {
      if (this.current === ac) this.current = null;
      if (opts.hideAtEnd && !ac.signal.aborted) this.setVisible(false);
    });
    return { done, stop: () => ac.abort() };
  }

  stop() {
    this.current?.abort();
    this.current = null;
    this.setSpotlight(null);
    this.controller.clearSpeech();
    this.controller.halt();
  }

  get playing() { return !!this.current; }

  /** Hooks for running single steps live (the recorder uses these). */
  hooks() {
    return {
      setVisible: (v: boolean) => this.setVisible(v),
      setSpotlight: (s: Spotlight | null) => this.setSpotlight(s),
      waitForClick: (sig?: AbortSignal) => this.waitForClick(sig),
      sizePx: () => this.sizePx(),
    };
  }
}

let stage: Stage | null = null;

/** The shared stage (mounts its overlay on first call). */
export function getStage(): Stage {
  if (stage) return stage;
  stage = new Stage();
  const host = document.createElement("div");
  host.setAttribute("data-firefly-ui", "stage");
  Object.assign(host.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483000", overflow: "hidden" });
  document.body.appendChild(host);
  createRoot(host).render(<StageView stage={stage} />);
  return stage;
}

/** Play a recorded script on the current page. Hides the mascot again at the end by default. */
export function playScript(script: FireflyScript, opts: { hideAtEnd?: boolean; onStep?: (i: number, s: ScriptStep) => void } = {}) {
  return getStage().play(script, { hideAtEnd: true, ...opts });
}

function StageView({ stage }: { stage: Stage }) {
  const s = useSyncExternalStore(stage.subscribe, stage.get);
  const [, frame] = useState(0);
  const [, resized] = useState(0);
  useEffect(() => stage.controller.subscribe(() => frame((f) => (f + 1) % 1e6)), [stage]);
  useEffect(() => {
    const on = () => resized((r) => r + 1);
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return (
    <>
      {s.spotlight && <SpotlightView stage={stage} spot={s.spotlight} awaiting={s.awaitingClick} />}
      {s.visible && <FireflyAgent controller={stage.controller} config={s.config} size={stage.sizePx()} />}
    </>
  );
}

/** Dimmed screen with a cut-out, glowing edge, lantern beam and click-to-continue. */
function SpotlightView({ stage, spot, awaiting }: { stage: Stage; spot: Spotlight; awaiting: boolean }) {
  const b = resolveArea(spot.area);
  const pad = 8;
  const x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad;
  const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const pal = stage.get().config.palette;
  const light = pal.lantern.startsWith("#") ? pal.lantern : "#ffe86a";

  // Beam: from the lantern to the two sides of the area (perpendicular to the beam).
  const L = stage.lanternPx();
  const dx = cx - L.x, dy = cy - L.y, len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  const half = 0.5 * (Math.abs(px) * w + Math.abs(py) * h) * 0.92;
  const beam = `${L.x},${L.y} ${cx + px * half},${cy + py * half} ${cx - px * half},${cy - py * half}`;

  const hole = spot.shape === "ellipse"
    ? <ellipse cx={cx} cy={cy} rx={(w / 2) * 1.12} ry={(h / 2) * 1.12} />
    : <rect x={x0} y={y0} width={w} height={h} rx={Math.min(14, w / 6, h / 6)} />;

  return (
    <div
      onClick={awaiting ? stage.clickThrough : undefined}
      style={{ position: "fixed", inset: 0, pointerEvents: awaiting ? "auto" : "none", cursor: awaiting ? "pointer" : "default", animation: "ffSpotIn .35s ease-out" }}
    >
      <style>{"@keyframes ffSpotIn{from{opacity:0}to{opacity:1}} @keyframes ffNudge{0%,100%{transform:translateX(0)}50%{transform:translateX(4px)}}"}</style>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
        <defs>
          <mask id="ff-spot-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            <g fill="black">{hole}</g>
          </mask>
          <linearGradient id="ff-beam" gradientUnits="userSpaceOnUse" x1={L.x} y1={L.y} x2={cx} y2={cy}>
            <stop offset="0%" stopColor={light} stopOpacity={0.55} />
            <stop offset="100%" stopColor={light} stopOpacity={0.06} />
          </linearGradient>
          <filter id="ff-spot-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(2, 8, 14, 0.72)" mask="url(#ff-spot-mask)" />
        <polygon points={beam} fill="url(#ff-beam)" style={{ mixBlendMode: "screen" }} />
        <g fill="none" stroke={light} strokeWidth={2} filter="url(#ff-spot-glow)">{hole}</g>
      </svg>
      {awaiting && (
        <div
          style={{
            position: "absolute", left: Math.min(innerWidth - 150, Math.max(10, cx - 70)), top: Math.min(innerHeight - 40, y1 + 14),
            padding: "5px 11px", borderRadius: 999, fontSize: 12, fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: "#04121c", background: light, boxShadow: `0 0 16px -4px ${light}`, animation: "ffNudge 1.2s ease-in-out infinite",
          }}
        >
          Click to continue ›
        </div>
      )}
    </div>
  );
}

export type { Stage };
