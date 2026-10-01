/**
 * Base geometries (built once, shared by every chunk).
 *   hexPrism()  — unit pointy-top prism, y ∈ [0,1], top face + 6 sides
 *   propLines() — unit wireframe props for NODE_TYPES[..].props
 */
import { BufferAttribute, BufferGeometry } from "three";
import { hexCorner } from "../hex/hexMath";
import type { PropKind } from "../hex/nodeTypes";
import type { BuildingKind } from "../hex/overlayStyles";

export function hexPrism(): BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], face: number[] = [], uv: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, nz: number, f: number, u: number, v: number) => {
    pos.push(x, y, z); nrm.push(nx, f ? 0 : 1, nz); face.push(f); uv.push(u, v);
  };
  // Top face (fan).
  for (let i = 0; i < 6; i++) {
    const [ax, az] = hexCorner(i), [bx, bz] = hexCorner((i + 1) % 6);
    push(0, 1, 0, 0, 0, 0, 0, 0);
    push(bx, 1, bz, 0, 0, 0, 0, 0);
    push(ax, 1, az, 0, 0, 0, 0, 0);
  }
  // Sides.
  for (let i = 0; i < 6; i++) {
    const [ax, az] = hexCorner(i), [bx, bz] = hexCorner((i + 1) % 6);
    const nx = (ax + bx) / 2, nz = (az + bz) / 2, l = Math.hypot(nx, nz);
    const q = [
      [ax, 0, az, 0, 0], [bx, 0, bz, 1, 0], [bx, 1, bz, 1, 1],
      [ax, 0, az, 0, 0], [bx, 1, bz, 1, 1], [ax, 1, az, 0, 1],
    ];
    for (const [x, y, z, u, v] of q) push(x, y, z, nx / l, nz / l, 1, u, v);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute("aFace", new BufferAttribute(new Float32Array(face), 1));
  g.setAttribute("aUV", new BufferAttribute(new Float32Array(uv), 2));
  return g;
}

// ---------------------------------------------------------------- props
type Seg = [number, number, number, number, number, number];

function ring(y: number, r: number, n: number, rot = 0): [number, number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
}
function cone(segs: Seg[], y0: number, r: number, apex: number, n: number) {
  const b = ring(y0, r, n, Math.PI / 4);
  b.forEach((p, i) => {
    const q = b[(i + 1) % n];
    segs.push([...p, ...q] as Seg, [...p, 0, apex, 0] as Seg);
  });
}
function box(segs: Seg[], w: number, d: number, h: number, y0 = 0) {
  const c = [[-w, -d], [w, -d], [w, d], [-w, d]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i], [bx, bz] = c[(i + 1) % 4];
    segs.push([ax, y0, az, bx, y0, bz], [ax, y0 + h, az, bx, y0 + h, bz], [ax, y0, az, ax, y0 + h, az]);
  }
}

const PROP_BUILDERS: Record<PropKind, () => Seg[]> = {
  pine: () => {
    const s: Seg[] = [[0, 0, 0, 0, 0.7, 0]];
    cone(s, 0.7, 0.9, 2.6, 4);
    cone(s, 1.6, 0.6, 3.3, 4);
    return s;
  },
  tree: () => {
    const s: Seg[] = [[0, 0, 0, 0, 0.8, 0]];
    const mid = ring(1.5, 0.8, 4);
    mid.forEach((p, i) => {
      const q = mid[(i + 1) % 4];
      s.push([...p, ...q] as Seg, [...p, 0, 0.8, 0] as Seg, [...p, 0, 2.3, 0] as Seg);
    });
    return s;
  },
  house: () => {
    const s: Seg[] = [];
    box(s, 0.8, 0.6, 0.9);
    s.push([-0.8, 0.9, 0, 0.8, 0.9, 0].map((v, i) => (i === 1 || i === 4 ? 1.5 : v)) as Seg);
    for (const x of [-0.8, 0.8]) s.push([x, 0.9, -0.6, x, 1.5, 0], [x, 0.9, 0.6, x, 1.5, 0]);
    return s;
  },
  tower: () => {
    const s: Seg[] = [];
    box(s, 0.5, 0.5, 3.4);
    for (const y of [1.1, 2.2]) box(s, 0.5, 0.5, 0, y);
    s.push([0, 3.4, 0, 0, 4.2, 0]);
    return s;
  },
  rock: () => {
    const p = [[-0.7, 0, -0.4], [0.6, 0, -0.5], [0.2, 0, 0.7], [0.05, 0.7, 0]];
    const s: Seg[] = [];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) s.push([...p[i], ...p[j]] as Seg);
    return s;
  },
};

const propCache = new Map<PropKind, BufferGeometry>();
export function propLines(kind: PropKind): BufferGeometry {
  let g = propCache.get(kind);
  if (!g) {
    const segs = PROP_BUILDERS[kind]();
    g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(segs.flat()), 3));
    propCache.set(kind, g);
  }
  return g;
}

// ---------------------------------------------------------------- buildings
// Unit space: footprint x,z in [-0.5, 0.5], height y in [0, 1] (scaled per instance).

function octRing(y: number, r: number, n = 8): [number, number, number][] {
  return ring(y, r, n, Math.PI / n);
}
function loop(segs: Seg[], pts: [number, number, number][]) {
  pts.forEach((p, i) => segs.push([...p, ...pts[(i + 1) % pts.length]] as Seg));
}
function join(segs: Seg[], a: [number, number, number][], b: [number, number, number][]) {
  a.forEach((p, i) => segs.push([...p, ...b[i]] as Seg));
}

const BUILDING_BUILDERS: Record<BuildingKind, () => Seg[]> = {
  block: () => {
    const s: Seg[] = [];
    box(s, 0.5, 0.5, 1);
    return s;
  },
  tower: () => {
    const s: Seg[] = [];
    box(s, 0.5, 0.5, 1);
    for (const y of [0.25, 0.5, 0.75]) box(s, 0.5, 0.5, 0, y); // floor bands
    s.push([0, 1, 0, 0, 1.06, 0]); // roof mast
    return s;
  },
  // Calgary Tower: flared base, tapering shaft, observation pod, spire.
  needle: () => {
    const s: Seg[] = [];
    const base = ring(0, 0.42, 4, Math.PI / 4), waist = ring(0.22, 0.13, 4, Math.PI / 4), top = ring(0.8, 0.1, 4, Math.PI / 4);
    loop(s, base); join(s, base, waist); join(s, waist, top);
    const podLo = octRing(0.8, 0.5), podHi = octRing(0.9, 0.5), crown = octRing(0.93, 0.28);
    loop(s, podLo); loop(s, podHi); loop(s, crown); join(s, podLo, podHi); join(s, podHi, crown);
    s.push([0, 0.93, 0, 0, 1, 0]);
    return s;
  },
  // Domed legislature: base block, drum, ribbed dome, lantern.
  dome: () => {
    const s: Seg[] = [];
    box(s, 0.5, 0.34, 0.42);
    const drumLo = octRing(0.42, 0.2), drumHi = octRing(0.58, 0.2);
    loop(s, drumLo); loop(s, drumHi); join(s, drumLo, drumHi);
    let prev = drumHi;
    for (const [y, r] of [[0.68, 0.18], [0.77, 0.13], [0.84, 0.07], [0.87, 0.02]] as const) {
      const cur = octRing(y, r);
      loop(s, cur); join(s, prev, cur); prev = cur;
    }
    s.push([0, 0.87, 0, 0, 1, 0]);
    return s;
  },
  // Saddledome: round bowl walls under a hyperbolic-paraboloid roof.
  saddle: () => {
    const s: Seg[] = [];
    const roofY = (x: number, z: number) => 0.62 + 1.4 * (x * x - z * z);
    const wallLo = ring(0, 0.5, 20), wallHi = wallLo.map(([x, , z]) => [x, roofY(x, z), z] as [number, number, number]);
    loop(s, wallLo); loop(s, wallHi);
    wallLo.forEach((p, i) => { if (i % 2 === 0) s.push([...p, ...wallHi[i]] as Seg); });
    for (let t = -0.4; t <= 0.41; t += 0.2) {
      for (const along of ["x", "z"] as const) {
        const pts: [number, number, number][] = [];
        for (let u = -0.5; u <= 0.5001; u += 0.1) {
          const x = along === "x" ? u : t, z = along === "x" ? t : u;
          if (x * x + z * z <= 0.25) pts.push([x, roofY(x, z), z]);
        }
        for (let i = 0; i + 1 < pts.length; i++) s.push([...pts[i], ...pts[i + 1]] as Seg);
      }
    }
    return s;
  },
  // Muttart Conservatory: four glass pyramids, two tall and two short.
  pyramids: () => {
    const s: Seg[] = [];
    for (const [cx, cz, h, r] of [[-0.25, -0.25, 1, 0.22], [0.25, 0.25, 1, 0.22], [0.25, -0.25, 0.75, 0.18], [-0.25, 0.25, 0.75, 0.18]]) {
      const b = ring(0, r * Math.SQRT2, 4, Math.PI / 4).map(([x, y, z]) => [x + cx, y, z + cz] as [number, number, number]);
      loop(s, b);
      b.forEach((p) => s.push([...p, cx, h, cz] as Seg));
    }
    return s;
  },
};

const buildingCache = new Map<BuildingKind, BufferGeometry>();
export function buildingLines(kind: BuildingKind): BufferGeometry {
  let g = buildingCache.get(kind);
  if (!g) {
    g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(BUILDING_BUILDERS[kind]().flat()), 3));
    buildingCache.set(kind, g);
  }
  return g;
}
