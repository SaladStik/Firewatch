/** Firefly on the map page: the shared mascot stage, parked bottom-left above the dock. */
import { getStage } from "../mascot/firefly/script";
import type { Engine } from "../engine";
import { project } from "../geo/projection";

/**
 * Where he rests: perched above the right end of the dock (and the Ask panel when it's open),
 * clear of the Layers/Legend column. Follows the stack as its chips and drawers come and go.
 */
export function homePoint() {
  const dock = document.querySelector("[data-tour=firefly]")?.getBoundingClientRect();
  if (!dock || !dock.width) return { x: 70, y: innerHeight - 230 };
  const stack = document.querySelector("[data-firefly-stack]")?.getBoundingClientRect();
  return { x: dock.right - 36, y: Math.min(dock.top, stack?.top ?? dock.top) - 40 };
}

export function showFirefly() {
  const st = getStage();
  st.setSize(0.085);
  st.setVisible(true);
  const h = homePoint();
  st.controller.teleport(h.x, h.y);
  return st;
}

/**
 * Keep him on the map: the recorder panel (FF) and tours hide the shared stage when they end,
 * so bring him back to the dock whenever he's hidden and no script is playing.
 */
export function keepFireflyShown() {
  const st = getStage();
  return st.subscribe(() => {
    if (st.get().visible || st.playing) return;
    queueMicrotask(() => { if (!st.get().visible && !st.playing) showFirefly(); });
  });
}

export const fireflyController = () => getStage().controller;

/** Each flight bumps this; an older flight's remaining waypoints are dropped. */
let flight = 0;

/** Where he parks while showing a spot: right of the screen centre (the camera centres the spot). */
const parkPoint = () => ({ x: innerWidth / 2 + Math.min(200, Math.max(110, innerWidth * 0.12)), y: innerHeight / 2 - 30 });

/**
 * While the camera flies to (lat, lng), Firefly does one round loop around the screen centre,
 * then parks right of centre looking at the spot.
 */
export async function flyFireflyTo(engine: Engine, lat: number, lng: number) {
  const id = ++flight;
  const ctl = fireflyController();
  ctl.lookAt(null);
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const r = Math.min(innerWidth, innerHeight) * 0.26;
  const park = parkPoint();
  // Sweep clockwise from where he is, one full loop, ending on the right-hand side.
  const a0 = Math.atan2(ctl.pose.y - cy, ctl.pose.x - cx);
  const sweep = ((((-a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) + 2 * Math.PI;
  const steps = Math.ceil(sweep / (Math.PI / 6));
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    await ctl.flyTo(cx + r * Math.cos(a), cy + r * Math.sin(a), { speed: 760, pass: 40 });
    if (id !== flight) return;
  }
  await ctl.flyTo(park.x, park.y, { speed: 420 });
  if (id !== flight) return;
  const w = project(lat, lng);
  const p = engine.scene.screenOf(w.x, w.z);
  ctl.lookAt(p.visible ? { x: p.x, y: p.y } : { x: cx, y: cy });
}

export async function flyFireflyHome() {
  const id = ++flight;
  const h = homePoint();
  const ctl = fireflyController();
  ctl.lookAt(null);
  await ctl.flyTo(h.x, h.y);
  return id === flight;
}

/** True while he's away from the dock (showing a spot). */
export function fireflyAway() {
  const h = homePoint(), p = fireflyController().pose;
  return Math.hypot(p.x - h.x, p.y - h.y) > 30;
}
