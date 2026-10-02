/**
 * Rain animation: short streaks falling onto the map wherever the rain field says
 * it's raining (real Open-Meteo rain + demo storms, data/rain.ts). A coarse intensity
 * grid over the view is rebuilt a few times a second and drops are spawned from it
 * (importance sampling), so rain looks equally dense per km² whether the storm fills
 * the view or a corner of it, and dry views cost nothing. The same grid is handed to the hex
 * shader as a texture, which tints wet ground blue (so it follows the terrain and is hidden by
 * mountains in front). Drawn after bloom (see Scene), depth-tested against the map.
 */
import { BufferAttribute, BufferGeometry, Color, Group, LineSegments, ShaderMaterial, Vector3 } from "three";
import type { RainField } from "../data/rain";
import type { WindField } from "../data/wind";
import { reliefKm } from "./heights";
import { makeRainTexture, sharedUniforms } from "./materials";

/** Most drops alive at once. */
const MAX = 1200;

/** Fall height, streak length and fall speed, as fractions of camera distance (zoom-independent look). */
const FALL_FRAC = 0.05;
const LEN_FRAC = 0.011;
const SPEED_FRAC = 0.09; // per second
/** Streak lean per km/h of wind (fraction of streak length), capped, and horizontal drift while falling. */
const LEAN_PER_KMH = 0.03;
const MAX_LEAN = 1.2;
const DRIFT_PER_KMH = 0.006; // fraction of the fall height drifted sideways per km/h
/** Seconds a drop slot waits before retrying after landing on a dry spot. */
const DRY_RETRY_S = 0.3;
/** Sampling grid over the view (cells per side) and how often it's rebuilt (s). */
const GRID = 28;
const GRID_EVERY_S = 0.4;
/** Drops for a view that's fully raining at intensity 1 (scaled by the wet share of the view). */
const FULL_VIEW_DROPS = 6000;

type GroundElev = (x: number, z: number) => number | null;

export class RainParticles {
  /** Add this to the scene (the falling streaks; the ground tint lives in the hex shader). */
  readonly object = new Group();
  readonly lines: LineSegments;
  /** Per grid cell rain intensity (0..255), uploaded as the hex shader's rain texture. */
  private tex = new Uint8Array(GRID * GRID);
  private rainTex = makeRainTexture(GRID, this.tex);
  private field: RainField | null = null;
  /** Wind the drops lean into and drift with (same field as the streamlines). */
  private wind: WindField | null = null;
  /** Per-drop wind (world XZ, km/h), sampled at spawn. */
  private vx = new Float32Array(MAX);
  private vz = new Float32Array(MAX);
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
      uniforms: { uColor: { value: new Color("#a8d6ff") }, uOpacity: { value: 0.42 } },
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity; varying float vA;
        void main(){ gl_FragColor = vec4(uColor, vA * uOpacity); }`,
      transparent: true,
      // The overlay pass draws into the map's own buffer, so drops hide behind mountains.
      depthTest: true,
      depthWrite: false,
    });
    this.lines = new LineSegments(g, this.mat);
    this.lines.frustumCulled = false;

    this.object.add(this.lines);
  }

  setField(field: RainField | null) {
    this.field = field?.any ? field : null;
    if (!this.field) this.lines.geometry.setDrawRange(0, 0);
    sharedUniforms.uRain.value.w = this.field ? 1 : 0;
    sharedUniforms.uRainTex.value = this.rainTex;
    this.h.fill(-1);
    this.gridKey = "";
  }

  setWind(wind: WindField | null) {
    this.wind = wind;
  }

  setTheme(light: boolean) {
    this.mat.uniforms.uColor.value.set(light ? "#1f5c96" : "#a8d6ff");
    this.mat.uniforms.uOpacity.value = light ? 0.4 : 0.42;
  }

  update(dt: number, target: Vector3, dist: number, groundElev: GroundElev) {
    const f = this.field;
    if (!f) return;
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    const radius = dist * 0.8, fall = dist * FALL_FRAC, len = dist * LEN_FRAC;
    this.buildGrid(target, radius, groundElev);
    // Mean intensity over the view → drop count, so density per km² stays the same at any rain size.
    // Fewer drops close in, where each one is big on screen: rain should read, not curtain the view.
    const zoomK = Math.min(1, Math.max(0.3, dist / 400));
    const active = this.wet > 0 ? Math.round(Math.min(MAX, Math.max(30, FULL_VIEW_DROPS * this.wet * zoomK))) : 0;
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
      // Wind: the drop drifts downwind as it falls (lands at x,z) and its streak leans into the wind.
      const wx = this.vx[i], wz = this.vz[i], kmh = Math.hypot(wx, wz);
      const drift = this.h[i] * fall * DRIFT_PER_KMH, lean = kmh > 0 ? (len * Math.min(MAX_LEAN, kmh * LEAN_PER_KMH)) / kmh : 0;
      const bx = this.x[i] - wx * drift, bz = this.z[i] - wz * drift;
      this.pos[v * 3] = bx - wx * lean; this.pos[v * 3 + 1] = y0 + len; this.pos[v * 3 + 2] = bz - wz * lean; this.alpha[v++] = 0;
      this.pos[v * 3] = bx; this.pos[v * 3 + 1] = y0; this.pos[v * 3 + 2] = bz;
      // Fade in at the top of the fall and out near the ground.
      this.alpha[v++] = this.a[i] * Math.min(1, this.h[i] * 6, (1 - this.h[i]) * 4);
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, v);
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }

  /** Sample the rain field on a coarse grid around the view (rebuilt when the view moves, or periodically). */
  private buildGrid(target: Vector3, radius: number, groundElev: GroundElev) {
    const key = `${Math.round(target.x / (radius * 0.1))},${Math.round(target.z / (radius * 0.1))},${Math.round(Math.log2(radius) * 4)}`;
    if (key === this.gridKey && this.clock < this.gridAt) return;
    this.gridKey = key;
    this.gridAt = this.clock + GRID_EVERY_S;
    this.cell = (radius * 2) / GRID;
    this.gx0 = target.x - radius;
    this.gz0 = target.z - radius;
    let sum = 0;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const n = j * GRID + i, x = this.gx0 + (i + 0.5) * this.cell, z = this.gz0 + (j + 0.5) * this.cell;
      // Off the loaded map: no rain there (no drops, no tint).
      const k = groundElev(x, z) == null ? 0 : this.field!.at(x, z);
      this.tex[n] = Math.round(k * 255);
      sum += k;
      this.cum[n] = sum;
    }
    this.rainTex.needsUpdate = true;
    sharedUniforms.uRain.value.set(this.gx0, this.gz0, this.cell * GRID, 1);
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
    const w = this.wind?.at(x, z);
    this.vx[i] = w?.vx ?? 0;
    this.vz[i] = w?.vz ?? 0;
    this.h[i] = 0.7 + Math.random() * 0.3;
    this.a[i] = 0.5 + 0.5 * k;
    return true;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.mat.dispose();
    this.rainTex.dispose();
    sharedUniforms.uRain.value.w = 0;
  }
}
