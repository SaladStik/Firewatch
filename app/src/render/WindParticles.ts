/**
 * Windfinder-style wind streamlines: thin streaks drifting along the wind field.
 * Particles live around the camera target and move with the (interpolated) wind;
 * each is drawn as one segment fading from head to tail, longer in stronger wind.
 * Fewer particles when zoomed in. Drawn in a pass after bloom (see Scene), so they
 * never glow.
 */
import { BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector3 } from "three";
import { BASE_ELEVATION_M } from "../config/grid";
import type { WindField } from "../data/wind";
import { sharedUniforms } from "./materials";

/** Most particles alive at once (far zoom). */
const MAX = 900;
/** Streak length and drift speed scale with camera distance so they look the same at every zoom. */
const TRAIL_FRAC = 0.03;
const SPEED_FRAC = 0.0022; // fraction of camera distance per second, per km/h
/** Ground elevation is re-read every this many frames per particle (staggered). */
const GROUND_EVERY = 8;
/**
 * How fast a streak eases toward the ground under it (1/s). Hexes are terraced, so
 * snapping to each hex's height made streaks jolt up and down on screen.
 */
const GROUND_EASE = 1.2;

type GroundElev = (x: number, z: number) => number | null;

export class WindParticles {
  readonly lines: LineSegments;
  private field: WindField | null = null;
  private x = new Float32Array(MAX);
  private z = new Float32Array(MAX);
  /** Smoothed ground elevation (m) the streak floats over, and the latest sample it eases toward. */
  private elev = new Float32Array(MAX);
  private elevTarget = new Float32Array(MAX);
  private age = new Float32Array(MAX);
  private life = new Float32Array(MAX).fill(-1); // < 0 = needs spawning
  private pos = new Float32Array(MAX * 6);
  private alpha = new Float32Array(MAX * 2);
  private mat: ShaderMaterial;
  private frame = 0;

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(this.pos, 3));
    g.setAttribute("aAlpha", new BufferAttribute(this.alpha, 1));
    this.mat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color("#ffffff") }, uOpacity: { value: 0.7 } },
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity; varying float vA;
        void main(){ gl_FragColor = vec4(uColor, vA * uOpacity); }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.lines = new LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
  }

  setField(field: WindField | null) {
    this.field = field;
    if (!field) this.lines.geometry.setDrawRange(0, 0);
  }

  setTheme(light: boolean) {
    this.mat.uniforms.uColor.value.set(light ? "#1b2a38" : "#ffffff");
    this.mat.uniforms.uOpacity.value = light ? 0.55 : 0.7;
  }

  /** Advance and redraw. `groundElev` gives the ground elevation (m) at a point, or null off the map. */
  update(dt: number, target: Vector3, dist: number, groundElev: GroundElev) {
    const f = this.field;
    if (!f) return;
    this.frame++;
    // Clamp: after a stall (hidden tab, hitch) particles shouldn't all expire at once.
    dt = Math.min(dt, 0.1);
    const active = Math.round(Math.min(MAX, 60 + dist * 0.45));
    const radius = dist * 0.8, step = SPEED_FRAC * dist * dt, lift = dist * 0.003, trail = dist * TRAIL_FRAC;
    const vScale = sharedUniforms.uVScale.value, ease = Math.min(1, dt * GROUND_EASE);
    for (let i = 0; i < active; i++) {
      this.age[i] += dt;
      let w = this.life[i] > 0 ? f.at(this.x[i], this.z[i]) : null;
      const far = Math.abs(this.x[i] - target.x) > radius * 1.2 || Math.abs(this.z[i] - target.z) > radius * 1.2;
      if (!w || far || this.age[i] > this.life[i]) w = this.spawn(i, target, radius, groundElev);
      else if ((i + this.frame) % GROUND_EVERY === 0) {
        const e = groundElev(this.x[i], this.z[i]);
        if (e == null) w = null; // drifted off the map
        else this.elevTarget[i] = e;
      }
      if (!w) { this.life[i] = -1; this.alpha[i * 2] = this.alpha[i * 2 + 1] = 0; continue; }
      this.x[i] += w.vx * step;
      this.z[i] += w.vz * step;
      // Fade in after spawning and out before dying; tail points back along the wind.
      const fade = Math.max(0, Math.min(1, this.age[i] / 0.6, (this.life[i] - this.age[i]) / 0.6));
      const len = (trail * Math.min(1.6, Math.max(0.4, w.kmh / 25))) / Math.max(w.kmh, 1e-3);
      this.elev[i] += (this.elevTarget[i] - this.elev[i]) * ease;
      // Same height mapping as the beacons/labels, re-scaled every frame so zooming stays smooth.
      const y = Math.max(0, (this.elev[i] - BASE_ELEVATION_M) / 1000) * vScale + lift;
      this.pos.set([this.x[i], y, this.z[i], this.x[i] - w.vx * len, y, this.z[i] - w.vz * len], i * 6);
      this.alpha[i * 2] = fade;
      this.alpha[i * 2 + 1] = 0;
    }
    for (let i = active; i < MAX; i++) this.life[i] = -1;
    const g = this.lines.geometry;
    g.setDrawRange(0, active * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }

  private spawn(i: number, target: Vector3, radius: number, groundElev: GroundElev) {
    for (let tries = 0; tries < 4; tries++) {
      const r = radius * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      const x = target.x + Math.cos(a) * r, z = target.z + Math.sin(a) * r;
      const w = this.field!.at(x, z);
      if (!w || w.kmh < 1) continue;
      const e = groundElev(x, z);
      if (e == null) continue;
      this.x[i] = x;
      this.z[i] = z;
      this.elev[i] = this.elevTarget[i] = e;
      this.age[i] = 0;
      this.life[i] = 2 + Math.random() * 3;
      return w;
    }
    return null;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}
