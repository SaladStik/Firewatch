/**
 * FireflyController — the "brain". Each frame it builds a pose from:
 *
 *   mood targets (eased)  +  procedural layers (flap, bob, blink, pulse, antenna sway)
 *   +  flight (seek / arrive / wander / follow, with banking)
 *   +  one-shot emotes (hop, spin, shake, nod, flutter)  +  talking mouth
 *
 * Everything is optional: set `manual = true` and write `pose` yourself, or
 * `override` single fields on top of the procedural result.
 */
import { DEFAULT_POSE } from "./config";
import { clamp } from "./Firefly";
import { MOODS, type MoodName, type MoodSpec } from "./moods";
import type { FireflyPose, WingPose } from "./types";

export type EmoteName = "hop" | "spin" | "shake" | "nod" | "flutter";
export const EMOTE_DURATION: Record<EmoteName, number> = { hop: 0.55, spin: 1.9, shake: 0.6, nod: 0.6, flutter: 0.9 };

export interface FlyOptions {
  /** Top speed in px/s (default 420). */
  speed?: number;
  /**
   * Pass-through waypoint: resolve as soon as he's within this many px and keep full
   * speed (no slowing down), so a chain of waypoints flies as one smooth path.
   */
  pass?: number;
}

type Listener = (pose: FireflyPose, ctl: FireflyController) => void;

export class FireflyController {
  pose: FireflyPose = clonePose(DEFAULT_POSE);
  mood: MoodName = "idle";
  /** Skip all procedural animation; you drive `pose` directly. */
  manual = false;
  /** Fields forced on top of the procedural pose every frame (e.g. { smile: -1 }). */
  override: Partial<Omit<FireflyPose, "wings">> = {};
  /** Wander randomly inside `bounds` when not flying anywhere. */
  wander = false;
  bounds = { x0: 80, y0: 80, x1: 800, y1: 500 };
  /** Text currently being "said" (render it in a bubble). */
  speech: string | null = null;

  private t = 0;
  private phase = 0;
  private blinkIn = 2.5;
  private blinkLeft = 0;
  private vel = { x: 0, y: 0 };
  private target: { x: number; y: number; speed: number; pass?: number; done?: () => void } | null = null;
  private followFn: (() => { x: number; y: number } | null) | null = null;
  private lookPoint: { x: number; y: number } | null = null;
  private emote: { name: EmoteName; t: number; onPeak?: () => void; peaked?: boolean } | null = null;
  private talkUntil = 0;
  private holdSpeech = false;
  /** Seconds the bubble stays after the mouth stops, so a line can be read. */
  private linger = 1.2;
  private wanderIn = 1;
  private raf = 0;
  private last = 0;
  private listeners = new Set<Listener>();

  constructor(opts: { x?: number; y?: number; mood?: MoodName } = {}) {
    this.pose.x = opts.x ?? 200;
    this.pose.y = opts.y ?? 200;
    if (opts.mood) this.mood = opts.mood;
  }

  // ------------------------------------------------------------ public API
  setMood(m: MoodName) { this.mood = m; }

  /** Fly to a screen point; resolves on arrival. */
  flyTo(x: number, y: number, opts: FlyOptions = {}): Promise<void> {
    this.followFn = null;
    this.target?.done?.();
    return new Promise((done) => { this.target = { x, y, speed: opts.speed ?? 420, pass: opts.pass, done }; });
  }

  /** Stop any flight / follow / emote immediately (pending flyTo promises resolve). */
  halt() {
    const done = this.target?.done;
    this.target = null;
    this.followFn = null;
    this.emote = null;
    this.vel = { x: 0, y: 0 };
    Object.assign(this.pose, { turn: 0, offsetX: 0, whirl: 0 });
    done?.();
  }

  /** Jump to a point instantly (no flight). */
  teleport(x: number, y: number) {
    this.pose.x = x;
    this.pose.y = y;
    this.vel = { x: 0, y: 0 };
  }

  /** True while a flyTo / follow is in progress. */
  get flying() { return !!this.target; }

  /** Continuously chase a point (e.g. the cursor). Pass null to stop. */
  follow(fn: (() => { x: number; y: number } | null) | null) { this.followFn = fn; }

  /** Eyes track a screen point. Pass null to look ahead. */
  lookAt(pt: { x: number; y: number } | null) { this.lookPoint = pt; }

  play(name: EmoteName) { this.emote = { name, t: 0 }; }

  /**
   * Transformation spin. `onPeak` fires at full speed, mid-whirl — swap his look
   * there (palette / config) for an "outfit change".
   */
  spin(opts: { onPeak?: () => void } = {}) { this.emote = { name: "spin", t: 0, onPeak: opts.onPeak }; }

  /**
   * Show a speech bubble and animate the mouth for `seconds`.
   * `hold`: keep the bubble up afterwards until clearSpeech() (e.g. tutorial steps).
   */
  say(text: string, seconds = Math.max(1.5, text.length * 0.06), opts: { hold?: boolean; linger?: number } = {}) {
    this.speech = text;
    this.talkUntil = this.t + seconds;
    this.holdSpeech = !!opts.hold;
    this.linger = opts.linger ?? 1.2;
  }

  clearSpeech() {
    this.speech = null;
    this.holdSpeech = false;
    this.talkUntil = 0;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.update(Math.min(0.05, (now - this.last) / 1000));
      this.last = now;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ------------------------------------------------------------ frame
  update(dt: number) {
    this.t += dt;
    if (!this.manual) {
      const m: MoodSpec = MOODS[this.mood];
      this.flight(dt);
      this.body(dt, m);
      this.face(dt, m);
      this.applyEmote(dt);
      Object.assign(this.pose, this.override);
    }
    for (const l of this.listeners) l(this.pose, this);
  }

  private flight(dt: number) {
    const p = this.pose;
    if (this.followFn) {
      const f = this.followFn();
      if (f) this.target = { x: f.x, y: f.y, speed: 520 };
    } else if (!this.target && this.wander) {
      this.wanderIn -= dt;
      if (this.wanderIn <= 0) {
        const b = this.bounds;
        this.target = { x: b.x0 + Math.random() * (b.x1 - b.x0), y: b.y0 + Math.random() * (b.y1 - b.y0), speed: 240 };
        this.wanderIn = 2 + Math.random() * 3;
      }
    }
    let ax = -this.vel.x * 3, ay = -this.vel.y * 3; // drag
    if (this.target) {
      const dx = this.target.x - p.x, dy = this.target.y - p.y, d = Math.hypot(dx, dy);
      // Arrive steering: full speed far away, ease in near the target.
      const want = this.target.pass ? this.target.speed : Math.min(this.target.speed, d * 3);
      const vx = d > 0 ? (dx / d) * want : 0, vy = d > 0 ? (dy / d) * want : 0;
      ax = (vx - this.vel.x) * 6;
      ay = (vy - this.vel.y) * 6;
      const arrived = this.target.pass ? d < this.target.pass : d < 3 && Math.hypot(this.vel.x, this.vel.y) < 25;
      if (arrived && !this.followFn) {
        const done = this.target.done;
        this.target = null;
        done?.();
      }
    }
    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    p.x += this.vel.x * dt;
    p.y += this.vel.y * dt;
  }

  private body(dt: number, m: MoodSpec) {
    const p = this.pose, t = this.t;
    const speed = Math.hypot(this.vel.x, this.vel.y);
    const k = 1 - Math.exp(-dt * 6);

    // Wings: faster + wider beats while flying. Lower pair lags the upper pair.
    const hz = m.flapHz + Math.min(1, speed / 300) * 7;
    this.phase += dt * hz * Math.PI * 2;
    const amp = m.flapAmp + Math.min(1, speed / 300) * 8;
    const wing = (lag: number, scale: number): WingPose => ({
      lift: m.wingLift + Math.sin(this.phase - lag) * amp * scale,
      open: 0.75 + 0.25 * Math.cos(this.phase - lag),
    });
    p.wings.upperL = wing(0, 1);
    p.wings.upperR = wing(0, 1);
    p.wings.lowerL = wing(0.7, 0.75);
    p.wings.lowerR = wing(0.7, 0.75);

    // Hover bob + banking into the direction of travel.
    p.hover = Math.sin(t * Math.PI * 2 * m.bobHz) * m.bob;
    const bank = clamp(this.vel.x * 0.05, -28, 28);
    const wiggle = Math.sin(t * 9) * m.wiggle;
    p.rotation += (m.tilt + bank + wiggle - p.rotation) * k;

    // Antennae: idle sway + drag behind motion.
    const sway = Math.sin(t * 1.7) * 5;
    const drag = clamp(-this.vel.x * 0.03, -20, 20) + clamp(this.vel.y * 0.03, -10, 15);
    p.antennaL += (m.antenna + sway + drag - p.antennaL) * k;
    p.antennaR += (m.antenna - sway - drag - p.antennaR) * k;

    // Lantern pulse + alert colour.
    p.lantern = m.lantern + Math.sin(t * Math.PI * 2 * m.pulseHz) * m.pulseAmt;
    p.alarm += (m.alarm - p.alarm) * k;
    p.squash += (0 - p.squash) * k;
    p.scale += (1 - p.scale) * k;
  }

  private face(dt: number, m: MoodSpec) {
    const p = this.pose, f = m.face, k = 1 - Math.exp(-dt * 8);
    const ease = (key: "smile" | "brow" | "browAmount" | "blush", v = 0) => { p[key] += (v - p[key]) * k; };
    ease("smile", f.smile);
    ease("brow", f.brow);
    ease("browAmount", f.browAmount);
    ease("blush", f.blush);

    // Blink on a random timer (never while sleepy — that's already nearly shut).
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) { this.blinkLeft = 0.13; this.blinkIn = 2.2 + Math.random() * 3.5; }
    this.blinkLeft = Math.max(0, this.blinkLeft - dt);
    const eye = (f.eyeOpen ?? 1) * (this.blinkLeft > 0 ? 0.05 : 1);
    p.eyeOpenL += (eye - p.eyeOpenL) * (this.blinkLeft > 0 ? 1 : k);
    p.eyeOpenR += (eye - p.eyeOpenR) * (this.blinkLeft > 0 ? 1 : k);

    // Gaze: at a point, else ahead in the direction of travel.
    let lx = clamp(this.vel.x / 400, -1, 1), ly = (f.lookY ?? 0) + clamp(this.vel.y / 500, -0.6, 0.6);
    if (this.lookPoint) {
      lx = clamp((this.lookPoint.x - p.x) / 260, -1, 1);
      ly = clamp((this.lookPoint.y - (p.y + p.hover)) / 260, -1, 1);
    }
    p.lookX += (lx - p.lookX) * k;
    p.lookY += (ly - p.lookY) * k;

    // Mouth: talking flaps it, otherwise the mood's value.
    if (this.t < this.talkUntil) {
      p.mouthOpen = 0.15 + 0.55 * Math.abs(Math.sin(this.t * 13)) * (0.6 + 0.4 * Math.sin(this.t * 3.1));
    } else {
      if (this.speech && !this.holdSpeech && this.t > this.talkUntil + this.linger) this.speech = null;
      p.mouthOpen += ((f.mouthOpen ?? 0) - p.mouthOpen) * k;
    }
  }

  private applyEmote(dt: number) {
    if (!this.emote) return;
    const e = this.emote, p = this.pose;
    e.t += dt;
    const dur = EMOTE_DURATION[e.name], u = Math.min(1, e.t / dur);
    const bell = Math.sin(u * Math.PI);
    switch (e.name) {
      case "hop":
        p.hover -= bell * 26;
        p.squash = u < 0.15 ? 0.18 * (u / 0.15) : u > 0.85 ? 0.15 * ((u - 0.85) / 0.15) : -0.1 * bell;
        break;
      case "spin": {
        // Dreidel / outfit-change spin: rise onto the "toe", raise the wings, whip round
        // ~5 times in place with an air whirl, then slow with a growing wobble and settle.
        const turns = SPIN_TURNS;
        const f = spinProgress(u);
        p.turn = f * turns * 360;
        const speed = spinSpeed(u); // 0..1
        const plateau = smooth(0, 0.12, u) * (1 - smooth(0.82, 1, u));
        p.hover -= plateau * 16;
        p.squash = -0.08 * plateau;
        for (const w of Object.values(p.wings)) { w.lift -= 34 * plateau; w.open = 1 - 0.45 * plateau; }
        const wobble = 2 + 16 * Math.pow(smooth(0.5, 1, u), 1.4) * (1 - smooth(0.92, 1, u));
        p.rotation += Math.sin((p.turn * Math.PI) / 180) * wobble;
        p.whirl = speed;
        p.whirlPhase = (p.turn * Math.PI) / 180;
        if (!e.peaked && u >= 0.5) { e.peaked = true; e.onPeak?.(); }
        break;
      }
      case "shake":
        p.rotation += Math.sin(u * Math.PI * 8) * 14 * (1 - u);
        break;
      case "nod":
        p.lookY += Math.sin(u * Math.PI * 4) * 0.6;
        p.hover += Math.sin(u * Math.PI * 4) * 4;
        break;
      case "flutter":
        for (const w of Object.values(p.wings)) w.lift += Math.sin(this.t * 60) * 18 * bell;
        p.scale = 1 + bell * 0.08;
        break;
    }
    if (u >= 1) {
      if (!e.peaked) e.onPeak?.();
      this.emote = null;
      p.turn = 0;
      p.offsetX = 0;
      p.whirl = 0;
    }
  }
}

// ---- spin profile: angular speed ramps up fast, holds, then winds down.
const SPIN_TURNS = 5;
function spinSpeed(u: number) {
  return smooth(0, 0.14, u) * (1 - smooth(0.5, 1, u) ** 0.8);
}
/** Normalised integral of spinSpeed (0..1), so the spin ends exactly facing forward. */
const SPIN_TABLE = (() => {
  const n = 200, t = new Float32Array(n + 1);
  for (let i = 1; i <= n; i++) t[i] = t[i - 1] + spinSpeed((i - 0.5) / n);
  for (let i = 0; i <= n; i++) t[i] /= t[n];
  return t;
})();
function spinProgress(u: number) {
  const x = clamp(u, 0, 1) * 200, i = Math.min(199, Math.floor(x));
  return SPIN_TABLE[i] + (SPIN_TABLE[i + 1] - SPIN_TABLE[i]) * (x - i);
}
function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function clonePose(p: FireflyPose): FireflyPose {
  return { ...p, wings: { upperL: { ...p.wings.upperL }, upperR: { ...p.wings.upperR }, lowerL: { ...p.wings.lowerL }, lowerR: { ...p.wings.lowerR } } };
}

