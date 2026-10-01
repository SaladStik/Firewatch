/**
 * Script player + helpers (smoothing, step descriptions).
 */
import { EMOTE_DURATION, type FireflyController } from "../controller";
import { MOODS, type MoodName } from "../moods";
import { resolveAnchor, resolveArea, viewportDiagonal } from "./anchors";
import type { Area, FireflyScript, ScriptStep } from "./types";

export interface PlayHooks {
  /** Show / hide the mascot (the stage implements this). */
  setVisible?: (v: boolean) => void;
  /** Called before each step (e.g. to highlight it in an editor). */
  onStep?: (index: number, step: ScriptStep) => void;
  signal?: AbortSignal;
  /** Spotlight overlay (the stage implements these). */
  setSpotlight?: (s: { area: Area; shape: "rect" | "ellipse" } | null) => void;
  /** Resolves when the viewer clicks through. */
  waitForClick?: (signal?: AbortSignal) => Promise<void>;
  /** Current mascot size in px (to keep him clear of the highlighted area). */
  sizePx?: () => number;
}

/** Default "say" duration for a line of text. */
export const sayDuration = (text: string) => Math.max(1.6, text.length * 0.065);

/** Radius (px) at which a pass-through waypoint counts as reached: a small share of the viewport. */
const passRadius = () => viewportDiagonal() * 0.03;

const sleep = (s: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, s * 1000);
    signal?.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
  });

/**
 * Execute one step on a controller. Resolves when the step is "done" (arrived, finished
 * talking, emote over, wait elapsed). Used by the player and by the recorder's live preview.
 */
export async function execStep(
  ctl: FireflyController,
  step: ScriptStep,
  defaults: { speed: number },
  hooks: PlayHooks = {},
): Promise<void> {
  const { signal } = hooks;
  switch (step.type) {
    case "fly": {
      const p = resolveAnchor(step.to);
      const fly = ctl.flyTo(p.x, p.y, {
        speed: (step.speed ?? defaults.speed) * viewportDiagonal(),
        pass: step.pass ? passRadius() : undefined,
      });
      await Promise.race([fly, new Promise<void>((d) => signal?.addEventListener("abort", () => d(), { once: true }))]);
      return;
    }
    case "look":
      ctl.lookAt(step.at ? resolveAnchor(step.at) : null);
      return;
    case "mood":
      ctl.setMood(step.mood);
      return;
    case "emote":
      if (step.emote === "spin") ctl.spin();
      else ctl.play(step.emote);
      return sleep(EMOTE_DURATION[step.emote], signal);
    case "say": {
      const s = step.seconds ?? sayDuration(step.text);
      ctl.say(step.text, s);
      return sleep(s, signal);
    }
    case "wait":
      return sleep(step.seconds, signal);
    case "show":
      if (step.at) { const p = resolveAnchor(step.at); ctl.teleport(p.x, p.y); }
      hooks.setVisible?.(true);
      return;
    case "hide":
      hooks.setVisible?.(false);
      return;
    case "spotlight": {
      if (!step.area) { hooks.setSpotlight?.(null); ctl.clearSpeech(); return; }
      const shape = step.shape ?? "rect";
      hooks.setSpotlight?.({ area: step.area, shape });
      const box = resolveArea(step.area);
      const spot = besideBox(box, hooks.sizePx?.() ?? 100);
      await Promise.race([
        ctl.flyTo(spot.x, spot.y, { speed: defaults.speed * viewportDiagonal() }),
        new Promise<void>((d) => signal?.addEventListener("abort", () => d(), { once: true })),
      ]);
      if (step.text) ctl.say(step.text, sayDuration(step.text), { hold: step.click !== false });
      if (step.click !== false) {
        await (hooks.waitForClick?.(signal) ?? sleep(sayDuration(step.text ?? "")));
        hooks.setSpotlight?.(null);
        ctl.clearSpeech();
      } else if (step.text) {
        await sleep(sayDuration(step.text), signal);
      }
      return;
    }
  }
}

/**
 * Where to hover next to a highlighted box: the side with the most free room,
 * far enough out that he doesn't cover it.
 */
export function besideBox(b: { x0: number; y0: number; x1: number; y1: number }, size: number) {
  const W = innerWidth, H = innerHeight, gap = size * 0.75;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const options = [
    { room: W - b.x1, x: b.x1 + gap, y: cy - size * 0.35 },  // right
    { room: b.x0, x: b.x0 - gap, y: cy - size * 0.35 },      // left
    { room: b.y0, x: cx, y: b.y0 - gap },                     // above
    { room: H - b.y1, x: cx, y: b.y1 + gap * 0.9 },           // below
  ].sort((a, c) => c.room - a.room);
  const o = options[0];
  return { x: Math.min(W - size * 0.5, Math.max(size * 0.5, o.x)), y: Math.min(H - size * 0.5, Math.max(size * 0.6, o.y)) };
}

/**
 * Put the mascot where he'd be just before step `index` (position, mood, visibility),
 * without playing the earlier steps. Used to play / step from the middle of a script.
 */
export function prepareAt(ctl: FireflyController, script: FireflyScript, index: number, hooks: PlayHooks = {}) {
  let at = resolveAnchor(script.start);
  let mood: MoodName = "idle";
  let visible = true;
  for (const s of script.steps.slice(0, index)) {
    if (s.type === "fly") at = resolveAnchor(s.to);
    if (s.type === "show") { visible = true; if (s.at) at = resolveAnchor(s.at); }
    if (s.type === "hide") visible = false;
    if (s.type === "mood") mood = s.mood;
  }
  ctl.halt();
  ctl.clearSpeech();
  ctl.setMood(mood);
  ctl.teleport(at.x, at.y);
  ctl.lookAt(null);
  hooks.setSpotlight?.(null);
  hooks.setVisible?.(visible);
}

/** Run a script (optionally from step `from`) on a controller. Resolves when finished or aborted. */
export async function runScript(ctl: FireflyController, script: FireflyScript, hooks: PlayHooks = {}, from = 0) {
  const { signal } = hooks;
  prepareAt(ctl, script, from, hooks);
  for (let i = from; i < script.steps.length; i++) {
    if (signal?.aborted) break;
    hooks.onStep?.(i, script.steps[i]);
    await execStep(ctl, script.steps[i], script, hooks);
  }
  hooks.onStep?.(-1, script.steps[0]);
  hooks.setSpotlight?.(null);
  ctl.clearSpeech();
  if (signal?.aborted) ctl.halt();
}

/**
 * Tidy a recording:
 *  - merge consecutive waits, round to 0.1 s, drop tiny ones (< 0.15 s)
 *  - keep only the last of consecutive mood changes / look targets
 *  - fly steps followed directly by another fly become pass-through waypoints (one smooth path)
 */
export function smoothScript(script: FireflyScript): FireflyScript {
  const out: ScriptStep[] = [];
  for (const step of script.steps) {
    const prev = out[out.length - 1];
    if (step.type === "wait" && prev?.type === "wait") { prev.seconds += step.seconds; continue; }
    if (step.type === "mood" && prev?.type === "mood") { out[out.length - 1] = { ...step }; continue; }
    if (step.type === "look" && prev?.type === "look") { out[out.length - 1] = { ...step }; continue; }
    out.push(structuredClone(step));
  }
  const steps = out
    .map((s) => (s.type === "wait" ? { ...s, seconds: Math.round(s.seconds * 10) / 10 } : s))
    .filter((s) => !(s.type === "wait" && s.seconds < 0.15));
  steps.forEach((s, i) => {
    if (s.type === "fly") s.pass = steps[i + 1]?.type === "fly" || undefined;
  });
  return { ...script, steps };
}

/** One-line human description of a step (editor list). */
export function describeStep(s: ScriptStep): string {
  const where = (a: { selector?: string; vx: number; vy: number }) =>
    a.selector ? `${shortSel(a.selector)}` : `${Math.round(a.vx * 100)}%, ${Math.round(a.vy * 100)}%`;
  switch (s.type) {
    case "fly": return `Fly → ${where(s.to)}${s.pass ? " (through)" : ""}`;
    case "look": return s.at ? `Look at ${where(s.at)}` : "Look ahead";
    case "mood": return `Mood: ${MOODS[s.mood]?.label ?? s.mood}`;
    case "emote": return `Emote: ${s.emote}`;
    case "say": return `Say “${s.text}”`;
    case "wait": return `Wait ${s.seconds}s`;
    case "show": return s.at ? `Show at ${where(s.at)}` : "Show";
    case "hide": return "Hide";
    case "spotlight": return s.area ? `Spotlight ${s.shape ?? "rect"}${s.area.selector ? " on " + shortSel(s.area.selector) : ""}${s.text ? ` · “${s.text}”` : ""}` : "Clear spotlight";
  }
}

const shortSel = (sel: string) => (sel.length > 28 ? "…" + sel.slice(-27) : sel);
