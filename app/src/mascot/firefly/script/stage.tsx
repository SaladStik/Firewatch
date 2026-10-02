/**
 * The Firefly stage: one fixed, click-through overlay layer (created on first use)
 * that hosts a single shared mascot on ANY page. Scripts play here, including
 * tutorial spotlights (dimmed screen + lantern beam + click to continue) and hands-on
 * tasks (the viewer must click / type in the highlighted part of the real app).
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
import type { Area, Ease, FireflyScript, ScriptStep, TaskAction } from "./types";

interface Spotlight { area: Area; shape: "rect" | "ellipse"; task?: { action: TaskAction; expect?: string } }
type TaskStep = Extract<ScriptStep, { type: "task" }>;
/** How long the "done" flash shows before a completed task moves on (s). */
const TASK_DONE_FLASH_S = 0.55;

interface StageState {
  visible: boolean;
  /** Size as a fraction of min(viewport w, h). */
  size: number;
  config: FireflyConfig;
  spotlight: Spotlight | null;
  /** Waiting for the viewer to click through. */
  awaitingClick: boolean;
  /** A task is waiting for the viewer; `taskDone` = just completed (success flash). */
  awaitingTask: boolean;
  taskDone: boolean;
}

/** FireflyAgent's SVG frame (see Firefly.tsx VIEW): width 210 units, body centre 92 units from the top. */
const VIEW_W = 210, CENTRE_FROM_TOP = 92;

class Stage {
  readonly controller = new FireflyController({ x: innerWidth / 2, y: innerHeight / 2 });
  private state: StageState = { visible: false, size: 0.11, config: DEFAULT_CONFIG, spotlight: null, awaitingClick: false, awaitingTask: false, taskDone: false };
  private listeners = new Set<() => void>();
  private current: AbortController | null = null;
  private clickResolve: (() => void) | null = null;
  private skipResolve: (() => void) | null = null;
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
  setSize(size: number) {
    this.sizeTween?.();
    this.set({ size });
  }

  private sizeTween: (() => void) | null = null;
  /** Animate the size to `size` over `seconds`; resolves when it lands (an abort snaps it there). */
  tweenSize(size: number, seconds: number, ease: Ease, signal?: AbortSignal) {
    this.sizeTween?.();
    const from = this.state.size;
    return new Promise<void>((done) => {
      if (seconds <= 0 || Math.abs(size - from) < 1e-4) { this.set({ size }); done(); return; }
      const t0 = performance.now();
      let raf = 0;
      const end = () => { cancelAnimationFrame(raf); this.sizeTween = null; this.set({ size }); done(); };
      const frame = () => {
        const u = Math.min(1, (performance.now() - t0) / (seconds * 1000));
        this.set({ size: from + (size - from) * EASE_FN[ease](u) });
        if (u < 1) raf = requestAnimationFrame(frame);
        else end();
      };
      this.sizeTween = end;
      signal?.addEventListener("abort", end, { once: true });
      raf = requestAnimationFrame(frame);
    });
  }
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

  /**
   * Resolves when the viewer does the task in the real app: a click inside the area, or
   * typing the expected text into a field inside it (anything + Enter when no text is set).
   * Events are only observed (capture phase), never blocked, so the app reacts normally.
   */
  waitForTask(step: TaskStep, signal?: AbortSignal) {
    return new Promise<"done" | "skipped">((done) => {
      const inBox = (x: number, y: number, pad: number) => {
        const b = resolveArea(step.area);
        return x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;
      };
      const fieldInBox = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement => {
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return false;
        // The anchored element itself (or a field inside it) always counts, wherever it moved.
        const anchored = step.area.selector ? safeQuery(step.area.selector) : null;
        if (anchored && (anchored === t || anchored.contains(t))) return true;
        const r = t.getBoundingClientRect();
        return inBox(r.left + r.width / 2, r.top + r.height / 2, 12);
      };
      const want = step.expect?.trim().toLowerCase() ?? "";
      const typedOk = (v: string) => (want ? v.trim().toLowerCase().includes(want) : v.trim().length > 0);
      const ours = (t: EventTarget | null) => t instanceof Element && !!t.closest("[data-firefly-ui]");
      let over = false;
      const finish = (r: "done" | "skipped") => {
        if (over) return;
        over = true;
        removeEventListener("click", onClick, true);
        removeEventListener("input", onInput, true);
        removeEventListener("keydown", onKey, true);
        this.skipResolve = null;
        if (r === "skipped" || signal?.aborted) {
          this.set({ awaitingTask: false, taskDone: false });
          done("skipped");
          return;
        }
        this.set({ awaitingTask: false, taskDone: true });
        setTimeout(() => { this.set({ taskDone: false }); done("done"); }, TASK_DONE_FLASH_S * 1000);
      };
      // Let the app handle the click first, then move on.
      const onClick = (e: MouseEvent) => {
        if (step.action === "click" && !ours(e.target) && inBox(e.clientX, e.clientY, 4)) setTimeout(() => finish("done"), 0);
      };
      const onInput = (e: Event) => {
        if (step.action === "type" && want && fieldInBox(e.target) && typedOk(e.target.value)) finish("done");
      };
      const onKey = (e: KeyboardEvent) => {
        if (step.action === "type" && e.key === "Enter" && fieldInBox(e.target) && typedOk(e.target.value)) finish("done");
      };
      addEventListener("click", onClick, true);
      addEventListener("input", onInput, true);
      addEventListener("keydown", onKey, true);
      signal?.addEventListener("abort", () => finish("skipped"), { once: true });
      this.skipResolve = () => finish("skipped");
      this.set({ awaitingTask: true, taskDone: false });
    });
  }
  skipTask = () => this.skipResolve?.();

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
      waitForTask: (step, sig) => this.waitForTask(step, sig),
      tweenSize: (size, secs, ease, sig) => this.tweenSize(size, secs, ease, sig),
      setSize: (size) => this.setSize(size),
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
      waitForTask: (step: TaskStep, sig?: AbortSignal) => this.waitForTask(step, sig),
      tweenSize: (size: number, secs: number, ease: Ease, sig?: AbortSignal) => this.tweenSize(size, secs, ease, sig),
      setSize: (size: number) => this.setSize(size),
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
      {s.spotlight && <SpotlightView stage={stage} spot={s.spotlight} awaiting={s.awaitingClick} task={s.awaitingTask} done={s.taskDone} />}
      {s.visible && <FireflyAgent controller={stage.controller} config={s.config} size={stage.sizePx()} />}
    </>
  );
}

/** Dimmed screen with a cut-out, glowing edge, lantern beam and click-to-continue. */
function SpotlightView({ stage, spot, awaiting, task, done }: { stage: Stage; spot: Spotlight; awaiting: boolean; task: boolean; done: boolean }) {
  const b = resolveArea(spot.area);
  const pad = 8;
  const x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad;
  const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const pal = stage.get().config.palette;
  const lantern = pal.lantern.startsWith("#") ? pal.lantern : "#ffe86a";
  const light = done ? "#5cff9d" : lantern;
  const isTask = !!spot.task;

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
      onClick={awaiting && !isTask ? stage.clickThrough : undefined}
      style={{ position: "fixed", inset: 0, pointerEvents: awaiting && !isTask ? "auto" : "none", cursor: awaiting && !isTask ? "pointer" : "default", animation: "ffSpotIn .35s ease-out" }}
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
      {/* Task: block everything except the highlighted area, which stays fully usable. */}
      {isTask && (task || done) && (
        <>
          <div style={{ ...blocker, left: 0, top: 0, width: "100%", height: Math.max(0, y0) }} />
          <div style={{ ...blocker, left: 0, top: y1, width: "100%", bottom: 0 }} />
          <div style={{ ...blocker, left: 0, top: y0, width: Math.max(0, x0), height: h }} />
          <div style={{ ...blocker, left: x1, top: y0, right: 0, height: h }} />
          <div
            style={{
              position: "absolute", left: Math.min(innerWidth - 300, Math.max(10, cx - 110)), top: y1 + 46 > innerHeight ? Math.max(8, y0 - 40) : y1 + 14,
              display: "flex", alignItems: "center", gap: 10, padding: "5px 6px 5px 12px", borderRadius: 999, fontSize: 12, pointerEvents: "auto",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#04121c", background: light, boxShadow: `0 0 16px -4px ${light}`,
              animation: done ? undefined : "ffNudge 1.2s ease-in-out infinite",
            }}
          >
            {done ? "\u2713 Nice!" : spot.task!.action === "click" ? "Click the highlighted area" : spot.task!.expect ? `Type \u201c${spot.task!.expect}\u201d` : "Type here, then press Enter"}
            {!done && (
              <button onClick={stage.skipTask} style={{ border: "none", borderRadius: 999, padding: "2px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", background: "rgba(4,18,28,.18)", color: "#04121c" }}>
                skip &rsaquo;
              </button>
            )}
          </div>
        </>
      )}
      {awaiting && !isTask && (
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

/** Easing curves (0..1 → 0..1) for size tweens. */
const EASE_FN: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  easeIn: (u) => u * u * u,
  easeOut: (u) => 1 - (1 - u) ** 3,
  easeInOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
  back: (u) => 1 + 2.7 * (u - 1) ** 3 + 1.7 * (u - 1) ** 2,
};

const safeQuery = (sel: string) => { try { return document.querySelector(sel); } catch { return null; } };

/** Invisible click-catcher outside a task's highlighted area. */
const blocker: React.CSSProperties = { position: "absolute", pointerEvents: "auto", background: "transparent" };

export type { Stage };
