/** Firefly on the map page: the shared mascot stage, parked bottom-left above the dock. */
import { getStage } from "../mascot/firefly/script";
import type { Engine } from "../engine";
import { project } from "../geo/projection";

/** Where he rests: just above the dock (bottom-left). */
export const homePoint = () => ({ x: 70, y: innerHeight - 190 });

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

/** After the camera has flown to (lat, lng), fly the mascot beside that spot on screen. */
export async function flyFireflyTo(engine: Engine, lat: number, lng: number, cameraSeconds = 1.7) {
  await new Promise((r) => setTimeout(r, cameraSeconds * 1000));
  const w = project(lat, lng);
  const p = engine.scene.screenOf(w.x, w.z);
  if (!p.visible) return;
  const ctl = fireflyController();
  await ctl.flyTo(Math.min(innerWidth - 60, p.x + 46), Math.max(60, p.y - 52));
  ctl.lookAt({ x: p.x, y: p.y });
}

export async function flyFireflyHome() {
  const h = homePoint();
  const ctl = fireflyController();
  ctl.lookAt(null);
  await ctl.flyTo(h.x, h.y);
}
