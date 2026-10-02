/**
 * Animated wind arrows: glowing comet-style chevrons that stream downwind across
 * each weather cell. Everything moves in the vertex shader (one draw call), so
 * a new forecast day only rebuilds a small buffer.
 *
 * Faster wind → faster, longer arrows; colour runs cyan (light) → white → amber (strong).
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, NormalBlending, ShaderMaterial } from "three";
import { BASE_ELEVATION_M } from "../config/grid";
import { sharedUniforms } from "./materials";

export interface WindArrow {
  x: number;
  z: number;
  /** Unit vector the wind blows toward (world XZ). */
  dx: number;
  dz: number;
  kmh: number;
  /** Ground elevation under the cell (m). */
  elev: number;
}

/** Arrows per weather cell, each on its own lane and phase so they don't march in step. */
const PER_CELL = 3;
/** Distance an arrow travels before it loops (km), roughly one weather cell. */
const SPAN_KM = 120;

/**
 * One arrow in local units (x = along the wind, y = across): a chevron head plus a
 * tapering tail. Third value is brightness (the tail fades out behind the head).
 */
const SHAPE: [number, number, number][] = [
  [1, 0, 1], [-0.6, 0.6, 1], [-0.25, 0, 1], [-0.6, -0.6, 1], // head
  [-0.25, 0.07, 0.5], [-0.25, -0.07, 0.5], [-2.4, 0.015, 0], [-2.4, -0.015, 0], // tail
];
const TRIS = [0, 1, 2, 0, 2, 3, 4, 6, 5, 5, 6, 7];

export class WindArrows {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: {
        uTime: sharedUniforms.uTime, uVScale: sharedUniforms.uVScale, uLight: sharedUniforms.uLight,
        uFocus: sharedUniforms.uFocus, uRadius: sharedUniforms.uRadius,
        uSize: { value: 10 }, uLift: { value: 20 }, uZoomFade: { value: 1 },
      },
      vertexShader: `
        uniform float uTime; uniform float uVScale; uniform float uSize; uniform float uLift;
        uniform float uZoomFade; uniform vec2 uFocus; uniform float uRadius;
        attribute vec3 aLocal; attribute vec3 aBase; attribute vec2 aDir; attribute vec3 aWind;
        varying float vA; varying float vT;
        void main(){
          float kmh = aWind.x;
          float s = fract(uTime * (0.03 + kmh * 0.004) + aWind.y);
          vec2 perp = vec2(-aDir.y, aDir.x);
          float len = 0.8 + min(kmh, 60.0) / 30.0;
          vec2 c = aBase.xy + aDir * (s - 0.5) * ${SPAN_KM.toFixed(1)} + perp * aWind.z * ${(SPAN_KM * 0.4).toFixed(1)};
          vec2 xz = c + (aDir * aLocal.x * len + perp * aLocal.y) * uSize;
          float y = max(0.0, (aBase.z - ${(BASE_ELEVATION_M / 1000).toFixed(3)}) * uVScale) + uLift;
          float ring = 1.0 - smoothstep(uRadius * 0.72, uRadius, length(xz - uFocus));
          // Fade in/out along the run; calm air shows nothing.
          vA = sin(3.14159 * s) * ring * aLocal.z * uZoomFade * smoothstep(1.0, 4.0, kmh);
          vT = clamp(kmh / 45.0, 0.0, 1.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
        }`,
      fragmentShader: `
        uniform float uLight;
        varying float vA; varying float vT;
        void main(){
          vec3 c = vT < 0.5 ? mix(vec3(0.2, 0.85, 1.0), vec3(0.9, 1.0, 1.0), vT * 2.0)
                            : mix(vec3(0.9, 1.0, 1.0), vec3(1.0, 0.72, 0.15), vT * 2.0 - 1.0);
          // Dark: additive glow (bloom picks it up). Light: solid ink, fading out.
          gl_FragColor = uLight > 0.5 ? vec4(mix(vec3(0.05, 0.3, 0.55), vec3(0.75, 0.4, 0.0), vT), vA) : vec4(c * vA * 0.7, 1.0);
        }`,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false, // an overlay: never hidden behind mountains
      side: DoubleSide, // flat shapes seen from above; winding flips with the wind direction
    });
    this.mesh = new Mesh(new BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  set(list: WindArrow[]) {
    const n = list.length * PER_CELL, nv = SHAPE.length;
    const local = new Float32Array(n * nv * 3), base = new Float32Array(n * nv * 3);
    const dir = new Float32Array(n * nv * 2), wind = new Float32Array(n * nv * 3);
    const index = new Uint32Array(n * TRIS.length);
    list.forEach((a, ci) => {
      for (let k = 0; k < PER_CELL; k++) {
        const i = ci * PER_CELL + k, v0 = i * nv;
        // Stagger lanes and phases per cell so neighbouring cells don't pulse together.
        const jitter = ((ci * 0.618034) % 1) * 0.25;
        const lane = (((k * 3) % PER_CELL) + 0.5) / PER_CELL - 0.5;
        for (let v = 0; v < nv; v++) {
          local.set(SHAPE[v], (v0 + v) * 3);
          base.set([a.x, a.z, a.elev / 1000], (v0 + v) * 3);
          dir.set([a.dx, a.dz], (v0 + v) * 2);
          wind.set([a.kmh, k / PER_CELL + jitter, lane], (v0 + v) * 3);
        }
        TRIS.forEach((t, j) => (index[i * TRIS.length + j] = v0 + t));
      }
    });
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(n * nv * 3), 3));
    g.setAttribute("aLocal", new BufferAttribute(local, 3));
    g.setAttribute("aBase", new BufferAttribute(base, 3));
    g.setAttribute("aDir", new BufferAttribute(dir, 2));
    g.setAttribute("aWind", new BufferAttribute(wind, 3));
    g.setIndex(new BufferAttribute(index, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** Per-frame: arrow size and height follow the camera; fade out when zoomed in past the data's resolution. */
  update(dist: number) {
    const u = this.mat.uniforms;
    u.uSize.value = Math.min(16, Math.max(0.25, dist * 0.0055));
    u.uLift.value = dist * 0.02;
    u.uZoomFade.value = Math.min(1, Math.max(0, (dist - 40) / 80));
  }

  setTheme(light: boolean) {
    this.mat.blending = light ? NormalBlending : AdditiveBlending;
    this.mat.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
