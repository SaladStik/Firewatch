/**
 * Hex top height — ONE formula shared by GLSL (hex + props) and JS (picking,
 * camera). Keep both versions in sync.
 */
import { BASE_ELEVATION_M } from "../config/grid";

/** Minimum prism thickness as a fraction of hex size. */
export const MIN_THICKNESS = 0.12;

export function hexTopY(elevM: number, lift: number, size: number, vScale: number): number {
  return Math.max(MIN_THICKNESS * size, ((elevM - BASE_ELEVATION_M) / 1000) * vScale) + lift * size;
}

export const HEIGHT_GLSL = /* glsl */ `
uniform float uVScale;
uniform float uSize;
float hexTop(float elevKm, float lift) {
  return max(${MIN_THICKNESS.toFixed(3)} * uSize, (elevKm - ${(BASE_ELEVATION_M / 1000).toFixed(3)}) * uVScale) + lift * uSize;
}`;
