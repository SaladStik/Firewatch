/**
 * Pure hex-grid math (no three.js, no DOM) — safe to use in workers and tests.
 *
 * Pointy-top hexes, axial (q, r) coordinates, "odd-r" offset (col, row) for
 * rectangular chunking. `size` is the circumradius in world units (km).
 * Reference: https://www.redblobgames.com/grids/hexagons/
 */

export const SQRT3 = Math.sqrt(3);

export interface Axial {
  q: number;
  r: number;
}

/** Hex centre in world XZ. */
export function hexToWorld(q: number, r: number, size: number): { x: number; z: number } {
  return { x: size * SQRT3 * (q + r / 2), z: size * 1.5 * r };
}

/** Hex containing a world XZ point. */
export function worldToHex(x: number, z: number, size: number): Axial {
  const q = ((SQRT3 / 3) * x - (1 / 3) * z) / size;
  const r = ((2 / 3) * z) / size;
  return axialRound(q, r);
}

export function axialRound(fq: number, fr: number): Axial {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

export function axialToOffset(q: number, r: number): { col: number; row: number } {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

export function offsetToAxial(col: number, row: number): Axial {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

export function hexDistance(a: Axial, b: Axial): number {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export const NEIGHBORS: readonly Axial[] = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

/** Corner i (0..5) of a pointy-top hex of circumradius 1, as [x, z]. */
export function hexCorner(i: number): [number, number] {
  const a = (Math.PI / 180) * (60 * i - 30);
  return [Math.cos(a), Math.sin(a)];
}

// ------------------------------------------------------------------ chunks
/** A chunk is an N×N block of offset (col,row) cells — rectangular in world space. */
export function chunkOf(q: number, r: number, n: number): { cx: number; cz: number } {
  const { col, row } = axialToOffset(q, r);
  return { cx: Math.floor(col / n), cz: Math.floor(row / n) };
}

export function chunkWorldBounds(cx: number, cz: number, n: number, size: number) {
  const w = SQRT3 * size;
  return {
    minX: cx * n * w - w,
    maxX: (cx + 1) * n * w + w,
    minZ: cz * n * 1.5 * size - size,
    maxZ: (cz + 1) * n * 1.5 * size + size,
  };
}

/** Chunk coords whose cells could lie within `radius` of (x, z). */
export function chunksInRadius(x: number, z: number, radius: number, n: number, size: number) {
  const cw = n * SQRT3 * size, ch = n * 1.5 * size;
  const out: { cx: number; cz: number; d: number }[] = [];
  const cx0 = Math.floor((x - radius) / cw), cx1 = Math.floor((x + radius) / cw);
  const cz0 = Math.floor((z - radius) / ch), cz1 = Math.floor((z + radius) / ch);
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    const nx = Math.max(cx * cw, Math.min(x, (cx + 1) * cw));
    const nz = Math.max(cz * ch, Math.min(z, (cz + 1) * ch));
    const d = Math.hypot(nx - x, nz - z);
    if (d <= radius) out.push({ cx, cz, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

export const hexKey = (level: number, q: number, r: number) => `${level}:${q},${r}`;
export const chunkKey = (level: number, cx: number, cz: number) => `${level}/${cx},${cz}`;

/** Deterministic 0..1 hash for per-hex variation (decoration jitter etc). */
export function hash01(q: number, r: number, salt = 0): number {
  let h = Math.imul(q | 0, 374761393) ^ Math.imul(r | 0, 668265263) ^ Math.imul(salt | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
