/**
 * Wind streamlines: continuous streams flowing along the wind field (windy.com style).
 * Particles live around the camera target and move with the (interpolated) wind; each
 * keeps a trail of the points it passed through, drawn as one curved polyline that
 * fades from head to tail, so the streams bend with the flow. Fewer particles when
 * zoomed in. Drawn in a pass after bloom (see Scene), so they never glow.
 */
import { BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector3 } from "three";
import type { WindField } from "../data/wind";
import { reliefKm } from "./heights";
import { sharedUniforms } from "./materials";

/** Most particles alive at once (far zoom). Kept low so the streams never hide the map. */
const MAX = 260;
/** Stream opacity (dark / light theme): a light touch over the hexes, not a curtain. */
const OPACITY_DARK = 0.32;
const OPACITY_LIGHT = 0.3;
/** Trail points kept per particle (more = smoother curves). */
const TRAIL_PTS = 24;
/** Trail length and drift speed scale with camera distance so they look the same at every zoom. */
const TRAIL_FRAC = 0.12;
const SPEED_FRAC = 0.0022; // fraction of camera distance per second, per km/h
/** Ground elevation is re-read every this many frames per particle (staggered). */
const GROUND_EVERY = 8;
/**
 * How fast a stream eases toward the ground under it (1/s). Hexes are terraced, so
 * snapping to each hex's height made streams jolt up and down on screen.
 */
const GROUND_EASE = 1.2;

type GroundElev = (x: number, z: number) => number | null;

export class WindParticles {
  readonly lines: LineSegments;
  private field: WindField | null = null;
  private x = new Float32Array(MAX);
  private z = new Float32Array(MAX);
  /** Smoothed ground elevation (m) the stream floats over, and the latest sample it eases toward. */
  private elev = new Float32Array(MAX);
  private elevTarget = new Float32Array(MAX);
  private age = new Float32Array(MAX);
  private life = new Float32Array(MAX).fill(-1); // < 0 = needs spawning
  /** Trail history, newest first: x, z, elevation (m) per point; `count` points in use. */
  private hx = new Float32Array(MAX * TRAIL_PTS);
  private hz = new Float32Array(MAX * TRAIL_PTS);
  private he = new Float32Array(MAX * TRAIL_PTS);
  private count = new Uint8Array(MAX);
  private pos = new Float32Array(MAX * TRAIL_PTS * 6);
  private alpha = new Float32Array(MAX * TRAIL_PTS * 2);
  private mat: ShaderMaterial;
  private frame = 0;

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(this.pos, 3));
    g.setAttribute("aAlpha", new BufferAttribute(this.alpha, 1));
    this.mat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color("#ffffff") }, uOpacity: { value: OPACITY_DARK } },
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
    this.mat.uniforms.uOpacity.value = light ? OPACITY_LIGHT : OPACITY_DARK;
  }

  /** Advance and redraw. `groundElev` gives the ground elevation (m) at a point, or null off the map. */
  update(dt: number, target: Vector3, dist: number, groundElev: GroundElev) {
    const f = this.field;
    if (!f) return;
    this.frame++;
    // Clamp: after a stall (hidden tab, hitch) particles shouldn't all expire at once.
    dt = Math.min(dt, 0.1);
    // Grows with zoom-out but slower than the visible area does, so far views stay sparse.
    const active = Math.round(Math.min(MAX, 30 + Math.sqrt(dist) * 5));
    const radius = dist * 0.8, step = SPEED_FRAC * dist * dt, lift = dist * 0.003;
    // A new trail point is laid every `seg` km travelled, so trail shape doesn't depend on fps.
    const seg = (dist * TRAIL_FRAC) / (TRAIL_PTS - 1);
    const vScale = sharedUniforms.uVScale.value, ease = Math.min(1, dt * GROUND_EASE);
    const y = (e: number) => reliefKm(e) * vScale + lift;
    let v = 0; // vertices written
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
      if (!w) { this.life[i] = -1; continue; }
      this.x[i] += w.vx * step;
      this.z[i] += w.vz * step;
      this.elev[i] += (this.elevTarget[i] - this.elev[i]) * ease;

      // Lay a trail point once the head has moved a segment's length from the newest one.
      const o = i * TRAIL_PTS;
      const n = this.count[i];
      if (n === 0 || Math.hypot(this.x[i] - this.hx[o], this.z[i] - this.hz[o]) >= seg) {
        this.hx.copyWithin(o + 1, o, o + TRAIL_PTS - 1);
        this.hz.copyWithin(o + 1, o, o + TRAIL_PTS - 1);
        this.he.copyWithin(o + 1, o, o + TRAIL_PTS - 1);
        this.hx[o] = this.x[i]; this.hz[o] = this.z[i]; this.he[o] = this.elev[i];
        this.count[i] = Math.min(TRAIL_PTS, n + 1);
      }

      // Fade the whole stream in after spawning and out before dying; each point fades toward the tail.
      const fade = Math.max(0, Math.min(1, this.age[i] / 0.8, (this.life[i] - this.age[i]) / 0.8));
      let px = this.x[i], pz = this.z[i], py = y(this.elev[i]), pa = fade;
      for (let k = 0; k < this.count[i]; k++) {
        const qx = this.hx[o + k], qz = this.hz[o + k], qy = y(this.he[o + k]);
        const t = 1 - (k + 1) / TRAIL_PTS;
        const qa = fade * t * t; // tail fades out quickly; only the head reads strongly
        this.pos[v * 3] = px; this.pos[v * 3 + 1] = py; this.pos[v * 3 + 2] = pz; this.alpha[v++] = pa;
        this.pos[v * 3] = qx; this.pos[v * 3 + 1] = qy; this.pos[v * 3 + 2] = qz; this.alpha[v++] = qa;
        px = qx; pz = qz; py = qy; pa = qa;
      }
    }
    for (let i = active; i < MAX; i++) this.life[i] = -1;
    const g = this.lines.geometry;
    g.setDrawRange(0, v);
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
      this.life[i] = 4 + Math.random() * 4;
      this.count[i] = 0;
      return w;
    }
    return null;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}
