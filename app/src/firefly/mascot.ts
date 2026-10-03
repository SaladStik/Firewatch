/** Firefly on the map page: the shared mascot stage. */
import { getStage } from "../mascot/firefly/script";
import type { Engine } from "../engine";
import { FIREFLY_CONFIG } from "../firefly.config";
import { project } from "../geo/projection";

/** SVG frame: body centre is this far down a box `size` px wide (see Firefly.tsx VIEW). */
const BODY_FROM_TOP = 92 / 210;

/** Where he rests: beside the Ask chat while it is open, otherwise on the Ask Firefly button. */
export function homePoint() {
  const chat = document.querySelector("[data-ask-chat]")?.getBoundingClientRect();
  if (chat && chat.width > 40) return { x: chat.right + 28, y: chat.top + 64 };
  const btn = document.querySelector("[data-ask-button]")?.getBoundingClientRect();
  if (btn && btn.width > 8) return poseOnButton(btn);
  return { x: innerWidth - 240, y: 48 };
}

/** Pose whose body sits on the button, nudged down if the drawing would leave the screen. */
function poseOnButton(btn: DOMRect) {
  const size = getStage().sizePx() || Math.round(0.085 * Math.min(innerWidth, innerHeight));
  const bodyFromTop = BODY_FROM_TOP * size;
  const x = btn.left + btn.width / 2;
  const bodyY = Math.max(btn.top + btn.height / 2, 4 + bodyFromTop);
  return { x, y: bodyY + size / 2 - bodyFromTop };
}

/** True after the chat closes, until Ask is opened again. */
let tucked = false;
export const fireflyTucked = () => tucked;
/** Bumps cancel an in-flight vanish or return. */
let burst = 0;

export function showFirefly() {
  const st = getStage();
  // keepFireflyShown() calls this again whenever he is hidden, so only set the look once.
  if (st.get().config !== FIREFLY_CONFIG) st.setConfig(FIREFLY_CONFIG);
  if (tucked) return st;
  st.setSize(0.085);
  st.setVisible(true);
  const h = homePoint();
  st.controller.teleport(h.x, h.y);
  st.controller.follow(() => homePoint());
  return st;
}

/**
 * Keep him on the map: the recorder panel (FF) and tours hide the shared stage when they end,
 * so bring him back to the dock whenever he's hidden and no script is playing.
 */
export function keepFireflyShown() {
  const st = getStage();
  return st.subscribe(() => {
    if (tucked || st.get().visible || st.playing) return;
    queueMicrotask(() => { if (!tucked && !st.get().visible && !st.playing) showFirefly(); });
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
  if (tucked) return;
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
  if (tucked) return false;
  const id = ++flight;
  const h = homePoint();
  const ctl = fireflyController();
  ctl.lookAt(null);
  await ctl.flyTo(h.x, h.y);
  if (id === flight) ctl.follow(() => homePoint());
  return id === flight;
}

const smooth = (u: number) => u * u * (3 - 2 * u);

function dropBurst(ctl: ReturnType<typeof fireflyController>) {
  const { scale: _s, whirl: _w, hover: _h, ...rest } = ctl.override;
  ctl.override = rest;
  ctl.pose.scale = 1;
  ctl.pose.whirl = 0;
}

/** Shrink and spin away. Stays hidden until `revealFirefly`. */
export async function dismissFirefly() {
  const token = ++burst;
  flight += 1;
  tucked = true;
  const ctl = fireflyController();
  ctl.halt();
  ctl.lookAt(null);
  ctl.clearSpeech();
  const btn = document.querySelector("[data-ask-button]")?.getBoundingClientRect();
  if (btn && btn.width > 8) {
    const spot = poseOnButton(btn);
    if (Math.hypot(ctl.pose.x - spot.x, ctl.pose.y - spot.y) < 160) ctl.teleport(spot.x, spot.y);
  }
  const from = ctl.pose.scale || 1;
  const t0 = performance.now();
  const seconds = 0.42;
  await new Promise<void>((done) => {
    const frame = () => {
      if (token !== burst) { done(); return; }
      const u = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      const pop = u < 0.18 ? u / 0.18 : 1;
      const shrink = u < 0.18 ? 1 : 1 - smooth((u - 0.18) / 0.82);
      ctl.override = { ...ctl.override, scale: from * (1 + 0.22 * pop) * shrink, whirl: Math.sin(Math.min(1, u / 0.75) * Math.PI), hover: -22 * smooth(u) };
      if (u < 1) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
  if (token !== burst) return;
  ctl.pose.scale = 0;
  ctl.override = { ...ctl.override, scale: 0, whirl: 0, hover: 0 };
  getStage().setVisible(false);
}

/** Grow back beside the open Ask chat. */
export async function revealFirefly() {
  const token = ++burst;
  flight += 1;
  tucked = false;
  const st = getStage();
  const ctl = st.controller;
  ctl.halt();
  ctl.lookAt(null);
  const h = homePoint();
  ctl.teleport(h.x, h.y);
  ctl.pose.scale = 0;
  ctl.override = { ...ctl.override, scale: 0, whirl: 1, hover: -10 };
  st.setVisible(true);
  const t0 = performance.now();
  const seconds = 0.48;
  await new Promise<void>((done) => {
    const frame = () => {
      if (token !== burst) { done(); return; }
      const u = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      const c1 = 1.4, c3 = c1 + 1;
      const grow = 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
      ctl.override = { ...ctl.override, scale: Math.max(0, grow), whirl: 1 - smooth(u), hover: -14 * Math.sin(u * Math.PI) };
      if (u < 1) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
  if (token !== burst) return;
  dropBurst(ctl);
  ctl.follow(() => homePoint());
}

/** True while he's away from where he rests (showing a spot). */
export function fireflyAway() {
  const h = homePoint(), p = fireflyController().pose;
  return Math.hypot(p.x - h.x, p.y - h.y) > 30;
}
