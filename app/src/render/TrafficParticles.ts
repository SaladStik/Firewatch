/**
 * Vehicles on the highways: short dashes driving along the baked corridors, as many of them
 * as the day's volume says, as slow as the congestion says, and stopped dead where fire has
 * the road closed.
 *
 * This is the traffic half of the demo scenario, the counterpart to the rain and wind
 * streams. It is a **street-zoom** layer: at province range a province's worth of cars is
 * noise, so nothing is drawn beyond FADE_OUT_KM and the full density only arrives by
 * FADE_IN_KM — around the two closest LOD levels, where hexes are small enough that a road
 * reads as a road. Zoom in on a threatened town in the scenario and you can watch the
 * evacuation pile into the closure.
 *
 * Time is compressed (TIME_LAPSE): at true speed a car crosses a street-zoom view in half an
 * hour, which reads as a still image.
 *
 * Drawn in the overlay pass after bloom (see Scene), so vehicles never glow.
 */
import { BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector3 } from "three";
import type { TrafficField, TrafficRoute } from "../data/trafficField";
import { reliefKm } from "./heights";
import { sharedUniforms } from "./materials";

/** Most vehicles alive at once. A jam on a trunk route should look like a jam. */
const MAX = 1600;
/** Nothing is drawn beyond this camera distance (km); full density by FADE_IN_KM. */
const FADE_OUT_KM = 200;
const FADE_IN_KM = 40;
/** Free-flowing highway speed (km/h). */
const FREE_KMH = 100;
/** Seconds of scenario time per second of real time. */
const TIME_LAPSE = 60;
/** Gridlock still creeps: speed is scaled by 1 − this × jam. */
const JAM_SLOWDOWN = 0.92;
/** Vehicle dash length as a fraction of camera distance, and its floor in km. */
const LEN_FRAC = 0.0016;
const LEN_MIN_KM = 0.03;
/** How high above the hex top they sit, as a fraction of camera distance. */
const LIFT_FRAC = 0.0009;
/** Ground elevation is re-read every this many frames per vehicle (staggered). */
const GROUND_EVERY = 12;
/** How fast a vehicle eases onto the ground under it (1/s) — hexes are terraced. */
const GROUND_EASE = 8;
/** Seconds a vehicle fades in after spawning and out before it is recycled. */
const FADE_S = 0.5;
/** Lifetime range (s). Short, so a queue of stopped cars keeps being refreshed. */
const LIFE_MIN = 6;
const LIFE_MAX = 16;
/** How far off the centreline the two directions of travel sit (km). */
const LANE_OFFSET_KM = 0.02;
/** The visible-route list is rebuilt this often (frames) rather than every frame. */
const ROUTES_EVERY = 20;

/** Dash colours: free-flowing, congested, stopped at a closure. Dark theme / light theme. */
const COLORS = {
  dark: { free: "#cfe3d2", jam: "#ffb000", stopped: "#ff2d2d" },
  light: { free: "#2a3a2c", jam: "#9a5a00", stopped: "#c01010" },
};
/** Opacity of the whole layer (dark / light). */
const OPACITY_DARK = 0.95;
const OPACITY_LIGHT = 0.85;

type GroundElev = (x: number, z: number) => number | null;

export class TrafficParticles {
  readonly lines: LineSegments;
  private field: TrafficField | null = null;
  private route: (TrafficRoute | null)[] = new Array(MAX).fill(null);
  /** Distance travelled along the route (km) and which way along it. */
  private s = new Float32Array(MAX);
  private dir = new Int8Array(MAX);
  private age = new Float32Array(MAX);
  private life = new Float32Array(MAX).fill(-1); // < 0 = needs spawning
  private elev = new Float32Array(MAX);
  private elevTarget = new Float32Array(MAX);
  private pos = new Float32Array(MAX * 6);
  private col = new Float32Array(MAX * 6);
  private alpha = new Float32Array(MAX * 2);
  private mat: ShaderMaterial;
  private frame = 0;
  /** Routes in view, with a cumulative weight for picking one in proportion to its traffic. */
  private visible: TrafficRoute[] = [];
  private cumulative: number[] = [];
  private cFree = new Color(COLORS.dark.free);
  private cJam = new Color(COLORS.dark.jam);
  private cStopped = new Color(COLORS.dark.stopped);
  private tmp = new Color();

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(this.pos, 3));
    g.setAttribute("aColor", new BufferAttribute(this.col, 3));
    g.setAttribute("aAlpha", new BufferAttribute(this.alpha, 1));
    this.mat = new ShaderMaterial({
      uniforms: { uOpacity: { value: OPACITY_DARK } },
      vertexShader: `
        attribute vec3 aColor; attribute float aAlpha; varying vec3 vC; varying float vA;
        void main(){ vC = aColor; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uOpacity; varying vec3 vC; varying float vA;
        void main(){ gl_FragColor = vec4(vC, vA * uOpacity); }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.lines = new LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
    this.lines.geometry.setDrawRange(0, 0);
  }

  setField(field: TrafficField | null) {
    this.field = field;
    this.visible = [];
    this.cumulative = [];
    if (!field) {
      this.lines.geometry.setDrawRange(0, 0);
      this.life.fill(-1);
    }
  }

  setTheme(light: boolean) {
    const p = light ? COLORS.light : COLORS.dark;
    this.cFree.set(p.free);
    this.cJam.set(p.jam);
    this.cStopped.set(p.stopped);
    this.mat.uniforms.uOpacity.value = light ? OPACITY_LIGHT : OPACITY_DARK;
  }

  /** Advance and redraw. `groundElev` gives the ground elevation (m) at a point, or null off the map. */
  update(dt: number, target: Vector3, dist: number, groundElev: GroundElev) {
    const f = this.field;
    // Beyond FADE_OUT_KM this is a street-zoom layer with nothing to say.
    if (!f || dist > FADE_OUT_KM) {
      this.lines.geometry.setDrawRange(0, 0);
      return;
    }
    this.frame++;
    dt = Math.min(dt, 0.1); // after a stall, don't expire every vehicle at once

    // Density ramps in as you zoom to street level.
    const zoom = Math.min(1, Math.max(0, (FADE_OUT_KM - dist) / (FADE_OUT_KM - FADE_IN_KM)));
    const radius = dist * 0.9;
    if (this.frame % ROUTES_EVERY === 1) this.collectRoutes(f, target, radius);
    const totalWeight = this.cumulative.length ? this.cumulative[this.cumulative.length - 1] : 0;
    if (!this.visible.length || totalWeight <= 0) {
      this.lines.geometry.setDrawRange(0, 0);
      return;
    }
    const active = Math.round(MAX * zoom * zoom);
    const len = Math.max(LEN_MIN_KM, dist * LEN_FRAC);
    const lift = dist * LIFT_FRAC;
    const vScale = sharedUniforms.uVScale.value;
    const ease = Math.min(1, dt * GROUND_EASE);
    const free = (FREE_KMH / 3600) * TIME_LAPSE; // km per second of real time

    let v = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        if (i >= active) continue;
        if (!this.spawn(i, f, totalWeight, groundElev)) continue;
      } else {
        this.age[i] += dt;
        if (this.age[i] > this.life[i] || i >= active) { this.life[i] = -1; i--; continue; }
      }
      const r = this.route[i];
      if (!r) { this.life[i] = -1; continue; }

      const here = f.sample(r, this.s[i]);
      // Fire across the road stops everything; short of that, congestion just slows it.
      const speed = here.closed ? 0 : free * (1 - JAM_SLOWDOWN * here.jam);
      this.s[i] += speed * this.dir[i] * dt;
      const span = f.length(r);
      if (this.s[i] < 0 || this.s[i] > span) { this.life[i] = -1; continue; } // drove off the end

      if ((i + this.frame) % GROUND_EVERY === 0) {
        const e = groundElev(here.x, here.z);
        if (e != null) this.elevTarget[i] = e;
      }
      this.elev[i] += (this.elevTarget[i] - this.elev[i]) * ease;

      // The dash points the way it is going, offset to its own side of the road.
      const ahead = f.sample(r, this.s[i] + this.dir[i] * Math.max(len, LEN_MIN_KM));
      let tx = ahead.x - here.x, tz = ahead.z - here.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const ox = -tz * LANE_OFFSET_KM * this.dir[i], oz = tx * LANE_OFFSET_KM * this.dir[i];
      const y = reliefKm(this.elev[i]) * vScale + lift;
      const fade = Math.max(0, Math.min(1, this.age[i] / FADE_S, (this.life[i] - this.age[i]) / FADE_S)) * zoom;

      // Free-flowing green-grey, warming to amber as the jam builds, red once it is stopped:
      // a build-up reads as a gradient down the road rather than a hard switch.
      const c = this.tmp;
      if (here.closed) c.copy(this.cStopped);
      else c.copy(this.cFree).lerp(this.cJam, Math.min(1, here.jam * 1.4));

      const hx = here.x + ox, hz = here.z + oz;
      this.pos[v * 3] = hx - tx * len * 0.5; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = hz - tz * len * 0.5;
      this.col[v * 3] = c.r; this.col[v * 3 + 1] = c.g; this.col[v * 3 + 2] = c.b;
      this.alpha[v++] = fade * 0.45; // tail of the dash is dimmer, so it reads as motion
      this.pos[v * 3] = hx + tx * len * 0.5; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = hz + tz * len * 0.5;
      this.col[v * 3] = c.r; this.col[v * 3 + 1] = c.g; this.col[v * 3 + 2] = c.b;
      this.alpha[v++] = fade;
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, v);
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }

  /**
   * Routes overlapping the view, with a cumulative weight of volume × length — the number of
   * vehicles actually on each one, so a trunk route gets its share and a back road gets its.
   */
  private collectRoutes(f: TrafficField, target: Vector3, radius: number) {
    this.visible = [];
    this.cumulative = [];
    let sum = 0;
    for (const r of f.routes) {
      if (r.maxX < target.x - radius || r.minX > target.x + radius) continue;
      if (r.maxZ < target.z - radius || r.minZ > target.z + radius) continue;
      // A road with no traffic on it has nothing to draw.
      const w = r.volume * f.length(r);
      if (w <= 0) continue;
      this.visible.push(r);
      sum += w;
      this.cumulative.push(sum);
    }
  }

  private spawn(i: number, f: TrafficField, totalWeight: number, groundElev: GroundElev): boolean {
    // Pick a route in proportion to how many vehicles are on it (binary search the weights).
    const pick = Math.random() * totalWeight;
    let lo = 0, hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < pick) lo = mid + 1; else hi = mid;
    }
    const r = this.visible[lo];
    if (!r) return false;
    const span = f.length(r);
    const s = Math.random() * span;
    const p = f.sample(r, s);
    const e = groundElev(p.x, p.z);
    if (e == null) return false; // off the map (another province's road, not loaded)
    this.route[i] = r;
    this.s[i] = s;
    this.dir[i] = Math.random() < 0.5 ? -1 : 1;
    this.age[i] = 0;
    this.life[i] = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    this.elev[i] = this.elevTarget[i] = e;
    return true;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}
