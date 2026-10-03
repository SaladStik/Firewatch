/**
 * What the arrow keys do to the camera. Pure maths on plain numbers — no three.js — so the
 * key map is testable without a WebGL context. Scene.ts owns which keys are held and feeds
 * them in once a frame.
 *
 * The arrows describe what the *camera* does, not what the ground does: Up goes forward, Up
 * with a modifier lifts towards a bird's-eye view, Right with one turns the compass
 * clockwise. That is the opposite sense from dragging with the mouse, which grabs the ground
 * and pulls it, and it is the sense people expect from arrow keys.
 */

/** Orbit target and camera position, in world km. */
export interface CameraPose {
  tx: number;
  ty: number;
  tz: number;
  cx: number;
  cy: number;
  cz: number;
}

/** The same bounds the mouse controls obey (MapControls min/maxDistance, min/maxPolarAngle). */
export interface CameraLimits {
  minDist: number;
  maxDist: number;
  minPolar: number;
  maxPolar: number;
}

export interface CameraKeyInput {
  /** +1 forward (ArrowUp), -1 back. */
  fwd: number;
  /** +1 right (ArrowRight), -1 left. */
  side: number;
  /** +1 out (Minus), -1 in (Equal). */
  zoom: number;
  /** Ctrl or Shift held: the arrows orbit and tilt instead of panning. */
  mod: boolean;
  /** Seconds since the last frame. */
  dt: number;
}

/** Pan speed as a fraction of camera distance per second — the same feel at every zoom. */
export const PAN_PER_S = 0.5;
/** Orbit and tilt speed (radians per second). */
export const ORBIT_PER_S = 0.9;
export const TILT_PER_S = 0.8;
/** Zoom multiplier per second while held. */
export const ZOOM_PER_S = 2.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Advance a pose by one frame's worth of held keys. Returns a new pose; the input is
 * untouched.
 *
 * Zoom is applied first, because it sets the distance the pan speed is scaled by.
 */
export function stepCamera(pose: CameraPose, inp: CameraKeyInput, lim: CameraLimits): CameraPose {
  const out = { ...pose };
  const dt = Math.max(0, inp.dt);
  if (dt === 0) return out;

  // Offset from target to camera, in the same spherical convention three.js uses:
  // radius from the target, phi down from +Y, theta from +Z towards +X.
  let ox = out.cx - out.tx, oy = out.cy - out.ty, oz = out.cz - out.tz;
  let r = Math.hypot(ox, oy, oz);
  if (r < 1e-6) return out;

  if (inp.zoom !== 0) {
    const want = clamp(r * ZOOM_PER_S ** (inp.zoom * dt), lim.minDist, lim.maxDist);
    const k = want / r;
    ox *= k; oy *= k; oz *= k;
    r = want;
  }

  if (inp.mod && (inp.fwd !== 0 || inp.side !== 0)) {
    const phi = Math.acos(clamp(oy / r, -1, 1));
    const theta = Math.atan2(ox, oz);
    const nextTheta = theta + inp.side * ORBIT_PER_S * dt;
    const nextPhi = clamp(phi - inp.fwd * TILT_PER_S * dt, lim.minPolar, lim.maxPolar);
    const s = Math.sin(nextPhi);
    ox = r * s * Math.sin(nextTheta);
    oy = r * Math.cos(nextPhi);
    oz = r * s * Math.cos(nextTheta);
  } else if (inp.fwd !== 0 || inp.side !== 0) {
    // Forward is away from the camera across the ground, so panning follows wherever you are
    // facing; right is forward turned a quarter turn (+X east, +Z south).
    const fx = -ox, fz = -oz;
    const len = Math.hypot(fx, fz) || 1;
    const step = PAN_PER_S * r * dt;
    const dx = ((fx / len) * inp.fwd + (-fz / len) * inp.side) * step;
    const dz = ((fz / len) * inp.fwd + (fx / len) * inp.side) * step;
    out.tx += dx;
    out.tz += dz;
  }

  out.cx = out.tx + ox;
  out.cy = out.ty + oy;
  out.cz = out.tz + oz;
  return out;
}

/** Degrees clockwise from north, matching Scene's `heading`. */
export function headingOf(pose: CameraPose): number {
  return (Math.atan2(pose.cx - pose.tx, pose.cz - pose.tz) * 180) / Math.PI;
}

/** Angle down from straight overhead (radians): small = bird's-eye, large = towards the horizon. */
export function polarOf(pose: CameraPose): number {
  const ox = pose.cx - pose.tx, oy = pose.cy - pose.ty, oz = pose.cz - pose.tz;
  const r = Math.hypot(ox, oy, oz) || 1;
  return Math.acos(clamp(oy / r, -1, 1));
}

/** Distance from the target to the camera (km). */
export function distanceOf(pose: CameraPose): number {
  return Math.hypot(pose.cx - pose.tx, pose.cy - pose.ty, pose.cz - pose.tz);
}
