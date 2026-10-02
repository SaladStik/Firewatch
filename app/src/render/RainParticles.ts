/**
 * Rain animation: short streaks falling onto the map wherever the rain field says
 * it's raining (real Open-Meteo rain + demo storms, data/rain.ts). A coarse intensity
 * grid over the view is rebuilt a few times a second and drops are spawned from it
 * (importance sampling), so rain looks equally dense per km² whether the storm fills
 * the view or a corner of it, and dry views cost nothing. Drawn after bloom (see Scene).
 */
import { BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector3 } from "three";
import type { RainField } from "../data/rain";
import { reliefKm } from "./heights";
import { sharedUniforms } from "./materials";

/** Most drops alive at once. */
const MAX = 1400;
/** Fall height, streak length and fall speed, as fractions of camera distance (zoom-independent look). */
const FALL_FRAC = 0.05;
const LEN_FRAC = 0.01;
const SPEED_FRAC = 0.09; // per second
/** Sideways lean of the streaks (as if blown slightly). */
const SLANT = 0.25;
/** Seconds a drop slot waits before retrying after landing on a dry spot. */
const DRY_RETRY_S = 0.3;
/** Sampling grid over the view (cells per side) and how often it's rebuilt (s). */
const GRID = 28;
const GRID_EVERY_S = 0.4;
/** Drops for a view that's fully raining at intensity 1 (scaled by the wet share of the view). */
const FULL_VIEW_DROPS = 2600;

type GroundElev = (x: number, z: number) => number | null;

export class RainParticles {
  readonly lines: LineSegments;
  private field: RainField | null = null;
  private x = new Float32Array(MAX);
  private z = new Float32Array(MAX);
  private ground = new Float32Array(MAX); // elevation (m)
  private h = new Float32Array(MAX).fill(-1); // height above ground, as a fraction of the fall (< 0 = respawn)
  private wait = new Float32Array(MAX); // dry-spot cooldown (s)
  private a = new Float32Array(MAX);
  private pos = new Float32Array(MAX * 6);
  private alpha = new Float32Array(MAX * 2);
  private mat: ShaderMaterial;
  /** Cumulative intensity over the sampling grid, its origin/cell size, and when it's next rebuilt. */
  private cum = new Float32Array(GRID * GRID);
  private gx0 = 0;
  private gz0 = 0;
  private cell = 1;
  private wet = 0;
  private gridAt = 0;
  private gridKey = "";
  private clock = 0;

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(this.pos, 3));
    g.setAttribute("aAlpha", new BufferAttribute(this.alpha, 1));
    this.mat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color("#8ec8ff") }, uOpacity: { value: 0.45 } },
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

  setField(field: RainField | null) {
    this.field = field?.any ? field : null;
    if (!this.field) this.lines.geometry.setDrawRange(0, 0);
    this.h.fill(-1);
    this.gridKey = "";
  }

  setTheme(light: boolean) {
    this.mat.uniforms.uColor.value.set(light ? "#2a5d8f" : "#8ec8ff");
    this.mat.uniforms.uOpacity.value = light ? 0.4 : 0.45;
  }

  update(dt: number, target: Vector3, dist: number, groundElev: GroundElev) {
    const f = this.field;
    if (!f) return;
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    const radius = dist * 0.8, fall = dist * FALL_FRAC, len = dist * LEN_FRAC;
    this.buildGrid(target, radius);
    // Mean intensity over the view → drop count, so density per km² stays the same at any rain size.
    const active = this.wet > 0 ? Math.round(Math.min(MAX, Math.max(40, FULL_VIEW_DROPS * this.wet))) : 0;
    const vScale = sharedUniforms.uVScale.value, step = (SPEED_FRAC * dist * dt) / fall;
    let v = 0;
    for (let i = 0; i < active; i++) {
      const far = Math.abs(this.x[i] - target.x) > radius * 1.2 || Math.abs(this.z[i] - target.z) > radius * 1.2;
      if (this.h[i] < 0 || far) {
        this.wait[i] -= dt;
        if (this.wait[i] > 0 || !this.spawn(i, target, groundElev)) continue;
      }
      this.h[i] -= step;
      if (this.h[i] < 0) continue;
      const y0 = reliefKm(this.ground[i]) * vScale + this.h[i] * fall;
      const sl = len * SLANT;
      this.pos[v * 3] = this.x[i]; this.pos[v * 3 + 1] = y0 + len; this.pos[v * 3 + 2] = this.z[i]; this.alpha[v++] = 0;
      this.pos[v * 3] = this.x[i] + sl; this.pos[v * 3 + 1] = y0; this.pos[v * 3 + 2] = this.z[i] + sl * 0.3;
      // Fade in at the top of the fall and out near the ground.
      this.alpha[v++] = this.a[i] * Math.min(1, this.h[i] * 6, (1 - this.h[i]) * 4);
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, v);
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }

  /** Sample the rain field on a coarse grid around the view (rebuilt when the view moves, or periodically). */
  private buildGrid(target: Vector3, radius: number) {
    const key = `${Math.round(target.x / (radius * 0.1))},${Math.round(target.z / (radius * 0.1))},${Math.round(Math.log2(radius) * 4)}`;
    if (key === this.gridKey && this.clock < this.gridAt) return;
    this.gridKey = key;
    this.gridAt = this.clock + GRID_EVERY_S;
    this.cell = (radius * 2) / GRID;
    this.gx0 = target.x - radius;
    this.gz0 = target.z - radius;
    let sum = 0;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      sum += this.field!.at(this.gx0 + (i + 0.5) * this.cell, this.gz0 + (j + 0.5) * this.cell);
      this.cum[j * GRID + i] = sum;
    }
    this.wet = sum / (GRID * GRID);
  }

  /** Place a drop in a rainy grid cell (weighted by intensity). False = landed dry; wait and retry. */
  private spawn(i: number, target: Vector3, groundElev: GroundElev) {
    const total = this.cum[GRID * GRID - 1];
    if (!(total > 0)) return false;
    const pick = Math.random() * total;
    let lo = 0, hi = GRID * GRID - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < pick) lo = mid + 1; else hi = mid; }
    const x = this.gx0 + ((lo % GRID) + Math.random()) * this.cell;
    const z = this.gz0 + (Math.floor(lo / GRID) + Math.random()) * this.cell;
    const k = this.field!.at(x, z);
    const e = k > 0 ? groundElev(x, z) : null;
    if (e == null) {
      this.h[i] = -1;
      this.wait[i] = DRY_RETRY_S * (0.5 + Math.random());
      this.x[i] = target.x; this.z[i] = target.z;
      return false;
    }
    this.x[i] = x;
    this.z[i] = z;
    this.ground[i] = e;
    this.h[i] = 0.7 + Math.random() * 0.3;
    this.a[i] = 0.5 + 0.5 * k;
    return true;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}
