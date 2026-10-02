/**
 * Scene — owns renderer, camera, controls, post-processing and overlays.
 * React talks to it through the small public API at the bottom.
 */
import gsap from "gsap";
import {
  AdditiveBlending, BufferAttribute, MOUSE, NormalBlending, BufferGeometry, Color, LineBasicMaterial, LineSegments, Mesh,
  PerspectiveCamera, PlaneGeometry, Raycaster, Scene as ThreeScene, ShaderMaterial, Vector2, Vector3, WebGLRenderer,
  WebGLRenderTarget,
  HalfFloatType,
} from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BASE_ELEVATION_M, GRID, RELIEF_EXPONENT, verticalScale } from "../config/grid";
import { reliefKm } from "./heights";
import { project } from "../geo/projection";
import type { Place } from "../data/places";
import type { WorldClient } from "../world/WorldClient";
import type { HexNodeInfo, TerrainMeta } from "../world/types";
import { HexWorld, type WorldStats } from "./HexWorld";
import { sharedUniforms } from "./materials";

export interface SceneEvents {
  onHover?: (n: HexNodeInfo | null) => void;
  onSelect?: (n: HexNodeInfo | null) => void;
  onStats?: (s: WorldStats & { dist: number; fps: number; vScale: number }) => void;
}

export interface Beacon {
  x: number;
  z: number;
  elev: number; // m
  simulated?: boolean;
}

const MIN_DIST = 2.5;

export class Scene {
  readonly world: HexWorld;
  private renderer: WebGLRenderer;
  private scene = new ThreeScene();
  private camera: PerspectiveCamera;
  private controls: MapControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private pointerDirty = false;
  private downAt: { x: number; y: number } | null = null;
  private raf = 0;
  private lastT = performance.now();
  private fps = 60;
  private beacons: LineSegments | null = null;
  private beaconMat: ShaderMaterial;
  private labels: { place: Place; region: number; el: HTMLDivElement; pos: Vector3; elevM: number; width: number; shown: boolean }[] = [];
  private labelMinPop = 0;
  private focus = new Set<number>([0]);
  private regionMetas = new Map<number, TerrainMeta>();
  private borders = new Map<number, LineSegments>();
  private client: WorldClient;
  private ro: ResizeObserver;
  private disposed = false;
  /** Always render at full native resolution (capped at 2× on HiDPI). Profiling showed the map is
   *  CPU/draw-call bound, not fill bound — rendering at lower resolution only made it grainy. */
  private maxPixelRatio = Math.min(window.devicePixelRatio, 2);
  /** Labels only re-layout when the camera, focus or label mode changes. */
  private labelsDirty = true;
  private lastCam = new Float32Array(16);
  private viewW = 1;
  private viewH = 1;
  private gridColor = { value: new Vector3(0.02, 0.16, 0.08) };
  private borderMat = new LineBasicMaterial({ color: new Color("#1d8f55") });
  private borderMatDim = new LineBasicMaterial({ color: new Color("#3a4a42") });
  private bloomWanted = true;
  private light = false;
  private home = { x: 0, z: 0, dist: 1500 };
  /** Far enough out to reach the national level and see all of Canada. */
  private maxDist = 9000;

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLDivElement,
    client: WorldClient,
    private events: SceneEvents,
  ) {
    this.client = client;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.setClearColor(new Color("#010403"));

    this.camera = new PerspectiveCamera(34, 1, 0.5, 20000);
    this.camera.position.set(this.home.x, this.home.dist * 0.62, this.home.z + this.home.dist * 0.79);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = MIN_DIST;
    this.controls.maxDistance = this.maxDist;
    this.controls.maxPolarAngle = 1.2;
    this.controls.minPolarAngle = 0.15;
    this.controls.zoomToCursor = true;
    this.controls.zoomSpeed = 1.4;
    // Left = pan, middle or right = rotate/tilt (Ctrl/Shift + left also rotates). Wheel zooms.
    this.controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.ROTATE };
    // Stop the browser's middle-click autoscroll from hijacking the drag.
    canvas.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    this.controls.target.set(this.home.x, 0, this.home.z);

    this.world = new HexWorld(client);
    this.world.onStats = (s) => this.events.onStats?.({ ...s, dist: this.distance, fps: this.fps, vScale: sharedUniforms.uVScale.value });
    this.scene.add(this.world.root);
    this.scene.add(this.makeGround());
    this.beaconMat = this.makeBeaconMaterial();

    // 4× MSAA on the composer's target — without it the post-processed image has no
    // antialiasing at all and hex edges / thin roads shimmer.
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.8, 0.4, 0.42);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.loop();
  }

  get distance() {
    return this.camera.position.distanceTo(this.controls.target);
  }

  // ------------------------------------------------------------ setup helpers
  private makeGround() {
    const mat = new ShaderMaterial({
      uniforms: { uFocus: sharedUniforms.uFocus, uRadius: sharedUniforms.uRadius, uGridColor: this.gridColor, uBg: sharedUniforms.uBg },
      vertexShader: `varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform vec2 uFocus; uniform float uRadius; uniform vec3 uGridColor; uniform vec3 uBg; varying vec2 vW;
        float grid(vec2 p, float s){ vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s); return 1.0 - min(min(g.x, g.y), 1.0); }
        void main(){
          float s = pow(10.0, floor(log(uRadius * 0.12) / log(10.0)));
          float fade = 1.0 - smoothstep(uRadius * 0.4, uRadius * 1.25, length(vW - uFocus));
          float g = grid(vW, s) * 0.5 + grid(vW, s * 10.0) * 0.8;
          gl_FragColor = vec4(mix(uBg, uGridColor, clamp(g * fade, 0.0, 1.0)), 1.0);
        }`,
      depthWrite: false,
    });
    const m = new Mesh(new PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), mat);
    m.position.y = -0.05;
    m.renderOrder = -1;
    return m;
  }

  /** Border rings as separate segments (a province can have many rings — islands, lakes). */
  private makeBorder(meta: TerrainMeta) {
    const pts: number[] = [];
    for (const ring of meta.border) {
      for (let i = 0; i + 1 < ring.length; i++) pts.push(ring[i][0], 0.02, ring[i][1], ring[i + 1][0], 0.02, ring[i + 1][1]);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
    return new LineSegments(g, this.borderMat);
  }

  /** A region's data finished loading: border line, labels, and (maybe) the home view. */
  addRegion(index: number, meta: TerrainMeta, places: Place[]) {
    this.regionMetas.set(index, meta);
    const border = this.makeBorder(meta);
    this.borders.set(index, border);
    this.scene.add(border);
    this.makeLabels(this.client, places, index);
    this.applyFocusVisuals();
  }

  /** Regions in focus render at full strength; home view fits them. */
  setFocus(indices: number[]) {
    this.focus = new Set(indices);
    this.labelsDirty = true;
    this.world.setFocus(indices);
    this.applyFocusVisuals();
  }

  private applyFocusVisuals() {
    for (const [i, b] of this.borders) b.material = this.focus.has(i) ? this.borderMat : this.borderMatDim;
    for (const l of this.labels) l.el.classList.toggle("map-label-dim", !this.focus.has(l.region));
    // Home = bounding box of the focused regions' rasters.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const i of this.focus) {
      const m = this.regionMetas.get(i);
      if (!m) continue;
      minX = Math.min(minX, m.minX); maxX = Math.max(maxX, m.minX + m.width * m.pxKm);
      minZ = Math.min(minZ, m.minZ); maxZ = Math.max(maxZ, m.minZ + m.height * m.pxKm);
    }
    if (minX < Infinity) {
      this.home = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, dist: Math.max(maxX - minX, maxZ - minZ) * 1.25 };
      this.maxDist = Math.max(this.maxDist, this.home.dist * 2);
      this.controls.maxDistance = this.maxDist;
    }
  }

  setLabelMinPop(minPop: number) {
    this.labelMinPop = minPop;
    this.labelsDirty = true;
  }

  private makeBeaconMaterial() {
    return new ShaderMaterial({
      uniforms: { uTime: sharedUniforms.uTime, uVScale: sharedUniforms.uVScale, uH: { value: 40 }, uLight: sharedUniforms.uLight },
      vertexShader: `
        uniform float uVScale; uniform float uH; uniform float uTime;
        attribute float aT; attribute float aElev; attribute float aSim;
        varying float vT; varying float vSim;
        void main(){
          vec3 p = position;
          float base = pow(max(0.0, aElev - ${(BASE_ELEVATION_M / 1000).toFixed(3)}), ${RELIEF_EXPONENT.toFixed(3)}) * uVScale;
          p.y = base + aT * uH * (0.85 + 0.15 * sin(uTime * 3.0 + position.x));
          vT = aT; vSim = aSim;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uLight;
        varying float vT; varying float vSim;
        void main(){
          vec3 c = mix(vec3(1.0, 0.18, 0.1), vec3(1.0, 0.55, 0.1), vSim);
          float a = pow(clamp(1.0 - vT, 0.0, 1.0), 1.6); // clamp: MSAA can extrapolate vT past 1 → pow(neg) = NaN
          // Dark: additive glow. Light: solid ink fading out (normal blending).
          gl_FragColor = uLight > 0.5 ? vec4(c * 0.55, a) : vec4(c * a * 1.6, 1.0);
        }`,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
  }

  private makeLabels(client: WorldClient, places: Place[], region: number) {
    for (const place of places) {
      const el = document.createElement("div");
      el.className = place.landmark ? "map-label map-label-landmark" : "map-label";
      el.innerHTML = `<span class="map-label-dot"></span><span>${place.name}</span>`;
      el.onclick = () => {
        const w = project(place.lat, place.lng);
        this.flyTo(w.x, w.z, 18);
      };
      this.overlay.appendChild(el);
      const w = project(place.lat, place.lng);
      const label = { place, region, el, pos: new Vector3(w.x, 0, w.z), elevM: 700, width: 26 + place.name.length * 7, shown: true };
      this.labels.push(label);
      client.sample(w.x, w.z).then((s) => {
        label.elevM = s.elevation;
        this.labelsDirty = true;
      });
    }
    // Biggest first (focused regions ahead of greyed ones): they win when labels would overlap.
    this.labels.sort((a, b) => b.place.pop - a.place.pop);
    this.labelsDirty = true;
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerDirty = true;
    });
    c.addEventListener("pointerdown", (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    c.addEventListener("pointerup", (e) => {
      if (!this.downAt || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved > 5) return;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const node = this.world.pick(this.raycaster.ray);
      this.select(node);
    });
    c.addEventListener("pointerleave", () => {
      sharedUniforms.uHover.value.z = 0;
      this.events.onHover?.(null);
    });
  }

  private resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.viewW = w;
    this.viewH = h;
    this.labelsDirty = true;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ frame loop
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    sharedUniforms.uTime.value = now / 1000;

    this.controls.update();
    const dist = this.distance;
    sharedUniforms.uVScale.value = verticalScale(dist);
    this.world.fitBounds(sharedUniforms.uVScale.value);
    sharedUniforms.uPxPerKm.value = (this.renderer.domElement.height) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    sharedUniforms.uBScale.value = Math.min(3, Math.max(1.5, sharedUniforms.uVScale.value * 0.5));
    this.camera.near = Math.max(0.05, dist * 0.02);
    this.camera.far = dist * 12 + 3000;
    this.camera.updateProjectionMatrix();

    const t = this.controls.target;
    this.camera.updateMatrixWorld();
    this.world.update(t.x, t.z, dist, this.camera);
    this.followTerrain();
    this.keepCameraAboveTerrain();
    sharedUniforms.uCam.value.copy(this.camera.position);
    sharedUniforms.uTarget.value.copy(t);
    (this.beaconMat.uniforms.uH.value as number) = Math.max(3, dist * 0.09);

    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const node = this.world.pick(this.raycaster.ray);
      const hv = sharedUniforms.uHover.value;
      if (node) hv.set(node.x, node.z, 1);
      else hv.z = 0;
      this.events.onHover?.(node);
    }
    this.updateLabels(dist);
    this.world.cullDetail(this.camera.position, sharedUniforms.uPxPerKm.value);
    this.composer.render();
  };

  /**
   * Never let the camera sink inside a hex column (mountains at close zoom). Anything still
   * between camera and target is drawn as outlines only (see `occluder()` in the hex shader).
   */
  private keepCameraAboveTerrain() {
    const c = this.camera.position;
    const node = this.world.nodeAt(c.x, c.z);
    if (!node) return;
    const clear = this.world.topY(node) + Math.max(0.15, GRID.levels[this.world.level].size * 0.6);
    if (c.y < clear) c.y = clear;
  }

  /** Keep the orbit target resting on the terrain surface. */
  private followTerrain() {
    const t = this.controls.target;
    const node = this.world.nodeAt(t.x, t.z);
    if (!node) return;
    const y = this.world.topY(node);
    const dy = (y - t.y) * 0.12;
    if (Math.abs(dy) < 1e-4) return;
    t.y += dy;
    this.camera.position.y += dy;
  }

  /**
   * Every community is labelled at every zoom. Labels are placed biggest-first and a
   * label that would overlap one already placed waits until you zoom in (declutter).
   */
  private updateLabels(dist: number) {
    // Skip the whole pass when nothing that affects label layout has changed (10k+ labels).
    const m = this.camera.matrixWorld.elements;
    let moved = this.labelsDirty;
    for (let i = 0; i < 16 && !moved; i++) moved = Math.abs(m[i] - this.lastCam[i]) > 1e-4;
    if (!moved) return;
    this.lastCam.set(m);
    this.labelsDirty = false;
    const w = this.viewW, h = this.viewH;
    const focus = sharedUniforms.uFocus.value, radius = sharedUniforms.uRadius.value;
    const v = new Vector3();
    const placed: [number, number, number, number][] = [];
    // Auto: major cities from afar; towns join as you zoom in.
    const minPop = this.labelMinPop >= 0 ? this.labelMinPop : dist > 120 ? 50_000 : dist > 40 ? 5_000 : 0;
    for (const l of this.labels) {
      const inRange = Math.hypot(l.pos.x - focus.x, l.pos.z - focus.y) < radius * 0.85;
      // Only provinces in focus are labelled, so each one's places stay readable.
      const hidden = !this.focus.has(l.region) || (l.place.landmark ? dist > 45 || minPop === Infinity : l.place.pop < minPop);
      if (!inRange || hidden) { hide(l); continue; }
      l.pos.y = reliefKm(l.elevM) * sharedUniforms.uVScale.value + dist * 0.01;
      v.copy(l.pos).project(this.camera);
      const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
      if (v.z > 1 || sx < -50 || sx > w + 50 || sy < -20 || sy > h + 20) { hide(l); continue; }
      const box: [number, number, number, number] = [sx - 4, sy - 10, sx + l.width, sy + 10];
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) {
        hide(l);
        continue;
      }
      placed.push(box);
      if (!l.shown) {
        l.shown = true;
        l.el.style.display = "";
      }
      l.el.style.transform = `translate(${sx | 0}px, ${sy | 0}px)`;
    }
  }

  // ------------------------------------------------------------ public API
  select(node: HexNodeInfo | null) {
    const sv = sharedUniforms.uSelect.value;
    if (node) sv.set(node.x, node.z, 1);
    else sv.z = 0;
    this.events.onSelect?.(node);
  }

  flyTo(x: number, z: number, dist = 30, duration = 1.6) {
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t).normalize();
    // Keep the view tilted even if the user was looking straight down.
    if (offset.y > 0.92) offset.set(0, 0.62, 0.79).normalize();
    const state = { x: t.x, z: t.z, d: this.distance };
    gsap.to(state, {
      x, z, d: dist, duration, ease: "power3.inOut", overwrite: true,
      onUpdate: () => {
        t.x = state.x;
        t.z = state.z;
        this.camera.position.copy(t).addScaledVector(offset, state.d);
      },
    });
  }

  zoomBy(factor: number) {
    const t = this.controls.target;
    this.flyTo(t.x, t.z, Math.min(this.maxDist, Math.max(MIN_DIST, this.distance * factor)), 0.6);
  }

  resetView() {
    this.flyTo(this.home.x, this.home.z, this.home.dist, 1.8);
  }

  /** Fly to fit one region. */
  flyToRegion(index: number) {
    const m = this.regionMetas.get(index);
    if (!m) return;
    const sx = m.width * m.pxKm, sz = m.height * m.pxKm;
    this.flyTo(m.minX + sx / 2, m.minZ + sz / 2, Math.max(sx, sz) * 1.25, 1.8);
  }

  setBeacons(list: Beacon[]) {
    if (this.beacons) {
      this.beacons.geometry.dispose();
      this.beacons.removeFromParent();
      this.beacons = null;
    }
    if (!list.length) return;
    const pos = new Float32Array(list.length * 6), aT = new Float32Array(list.length * 2);
    const aElev = new Float32Array(list.length * 2), aSim = new Float32Array(list.length * 2);
    list.forEach((b, i) => {
      pos.set([b.x, 0, b.z, b.x, 0, b.z], i * 6);
      aT.set([0, 1], i * 2);
      aElev.set([b.elev / 1000, b.elev / 1000], i * 2);
      aSim.set([b.simulated ? 1 : 0, b.simulated ? 1 : 0], i * 2);
    });
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aT", new BufferAttribute(aT, 1));
    g.setAttribute("aElev", new BufferAttribute(aElev, 1));
    g.setAttribute("aSim", new BufferAttribute(aSim, 1));
    this.beacons = new LineSegments(g, this.beaconMat);
    this.beacons.frustumCulled = false;
    this.scene.add(this.beacons);
  }

  setBloom(on: boolean) {
    this.bloomWanted = on;
    this.bloom.enabled = on && !this.light;
  }

  /** Dark = emissive lines on black. Light = the same map as ink on paper (government style). */
  setTheme(theme: "dark" | "light") {
    this.light = theme === "light";
    const bg = new Color(this.light ? "#f4f6f8" : "#010403");
    this.renderer.setClearColor(bg);
    sharedUniforms.uLight.value = this.light ? 1 : 0;
    sharedUniforms.uBg.value.set(bg.r, bg.g, bg.b);
    const grid = new Color(this.light ? "#c9d1d9" : "#062914");
    this.gridColor.value.set(grid.r, grid.g, grid.b);
    this.borderMat.color.set(this.light ? "#26374a" : "#1d8f55");
    this.borderMatDim.color.set(this.light ? "#9aa7b3" : "#3a4a42");
    this.beaconMat.blending = this.light ? NormalBlending : AdditiveBlending;
    this.beaconMat.needsUpdate = true;
    this.bloom.enabled = this.bloomWanted && !this.light;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.world.dispose();
    for (const l of this.labels) l.el.remove();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

/** Hide a label only if it isn't already hidden (avoids thousands of style writes per frame). */
function hide(l: { el: HTMLElement; shown: boolean }) {
  if (!l.shown) return;
  l.shown = false;
  l.el.style.display = "none";
}
