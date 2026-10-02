/**
 * Hex top height — ONE formula shared by GLSL (hex + props) and JS (picking,
 * camera). Keep both versions in sync.
 */
import { BASE_ELEVATION_M, RELIEF_EXPONENT } from "../config/grid";

/** Minimum prism thickness as a fraction of hex size. */
export const MIN_THICKNESS = 0.12;

/** Shaped relief in km (before vertical exaggeration). */
export function reliefKm(elevM: number): number {
  return Math.pow(Math.max(0, (elevM - BASE_ELEVATION_M) / 1000), RELIEF_EXPONENT);
}

export function hexTopY(elevM: number, lift: number, size: number, vScale: number): number {
  return Math.max(MIN_THICKNESS * size, reliefKm(elevM) * vScale) + lift * size;
}

export const HEIGHT_GLSL = /* glsl */ `
uniform float uVScale;
uniform float uSize;
float reliefKm(float elevKm) {
  return pow(max(0.0, elevKm - ${(BASE_ELEVATION_M / 1000).toFixed(3)}), ${RELIEF_EXPONENT.toFixed(3)});
}
float hexTop(float elevKm, float lift) {
  return max(${MIN_THICKNESS.toFixed(3)} * uSize, reliefKm(elevKm) * uVScale) + lift * uSize;
}`;
