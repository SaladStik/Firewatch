/**
 * The pitch's Firefly moment: the presenter "asks" where the next crew should go, Firefly flies in
 * and answers out loud, and the camera follows to the fire. Scripted so it can't go wrong on
 * stage, but the answer is the real one (the top fire and what the dispatcher sends to it).
 *
 * The voice, in order of preference:
 *  1. public/pitch/firefly-answer.mp3, pre-rendered in Firefly's ElevenLabs voice: instant, no
 *     network. Its loudness drives his mouth.
 *  2. The live ElevenLabs agent saying the line (a first-message override), only if this browser
 *     already allowed the microphone (a voice session needs it) and the agent allows the override.
 *  3. Just the speech bubble.
 */
import { VoiceConversation } from "@elevenlabs/client";
import { KIND } from "../dispatch/fleet";
import { label, type Scored } from "../dispatch/crews";
import { dispatch } from "../dispatch/store";
import { FIREFLY_CONFIG } from "../firefly.config";
import { getStage } from "../mascot/firefly/script";

export const QUESTION = "Firefly, where should our next crew go?";
const CLIP = `${import.meta.env.BASE_URL}pitch/firefly-answer.mp3`;
const AGENT_ID = (import.meta.env.VITE_ELEVENLABS_AGENT_ID as string | undefined) ?? "";

const DIRS: Record<string, string> = { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" };

/** The answer, from the data: the top fire, why, and who's going. */
export function answerFor(fire: Scored | null): string {
  if (!fire) return "Every fire on the list has a crew.";
  const f = fire.fire, near = fire.exposure.nearest;
  const where = near ? `, ${Math.round(near.km)} kilometres ${DIRS[near.dir] ?? near.dir} of ${near.name}` : "";
  const size = `${Math.round(f.sizeHa).toLocaleString("en-CA")} hectares`;
  const why = `It's ${size}${f.crown ? ", crowning," : ""} and spreading about ${Math.round(fire.ros)} metres a minute.`;
  const sent = dispatch.get().fleetDispatch.find((x) => x.fire === fire)?.assignments ?? [];
  const parts = sent.map((a) => `${article(KIND[a.resource.kind].label.toLowerCase())} from ${a.resource.base.name.replace(/\s*\(.*\)$/, "")}`);
  const first = sent.length ? Math.round(Math.min(...sent.map((a) => a.eta))) : 0;
  const go = parts.length ? ` I'd send ${list(parts)}. The first can be there in ${first} minutes.` : "";
  return `${label(fire).split(" ")[0]}${where}. ${why}${go}`;
}

const article = (s: string) => `${/^[aeio]/.test(s) ? "an" : "a"} ${s}`; // "a unit", "an air tanker"
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ------------------------------------------------------------ the mascot
function stage() {
  const st = getStage();
  if (st.get().config !== FIREFLY_CONFIG) st.setConfig(FIREFLY_CONFIG);
  return st;
}

/** Fly in from the right to his spot, lower right of the screen. */
export async function fireflyIn() {
  const st = stage(), ctl = st.controller;
  st.setSize(0.12);
  if (!st.get().visible) {
    ctl.teleport(innerWidth + 120, innerHeight * 0.45);
    st.setVisible(true);
  }
  ctl.setMood("idle");
  await ctl.flyTo(innerWidth * 0.78, innerHeight * 0.58, { speed: 1100 });
}

export function fireflyOut() {
  const st = getStage();
  if (!st.get().visible) return;
  st.controller.clearSpeech();
  delete st.controller.override.mouthOpen;
  void st.controller.flyTo(innerWidth + 160, innerHeight * 0.35, { speed: 1600 }).then(() => { if (!speaking) st.setVisible(false); });
}

export const fireflyMood = (m: "thinking" | "idle" | "alert") => stage().controller.setMood(m);

// ------------------------------------------------------------ the voice
let speaking = false;
let clipOk: boolean | null = null;

/** Whether the pre-rendered clip exists (asked once). */
export async function hasClip() {
  if (clipOk !== null) return clipOk;
  try { const r = await fetch(CLIP, { method: "HEAD" }); clipOk = r.ok && (r.headers.get("content-type") ?? "").includes("audio"); } catch { clipOk = false; }
  return clipOk;
}

/** Say the line: bubble always, voice when there is one. Resolves when he's done. */
export async function speak(text: string, signal: { cancelled: () => boolean }) {
  const ctl = stage().controller;
  speaking = true;
  ctl.setMood("idle");
  try {
    if (await hasClip() && await playClip(text, signal)) return;
    if (await liveAgent(text, signal)) return;
    // No voice: the bubble, at a reading pace.
    const secs = Math.max(4, text.length * 0.06);
    ctl.say(text, secs, { linger: 4 });
    await waitFor(secs * 1000, signal);
  } finally {
    speaking = false;
    delete ctl.override.mouthOpen;
  }
}

/**
 * Play the recorded line and move his mouth with it. False when it won't play, so the caller
 * can fall back to the live agent or the bubble.
 *
 * The browser blocks audio until the page has been interacted with, and the pitch starts
 * itself. A blocked play used to be swallowed, which left `audio.paused` true — so the wait
 * below finished on its first frame and the beat passed in silence without even pausing for
 * the line.
 */
async function playClip(text: string, signal: { cancelled: () => boolean }): Promise<boolean> {
  const ctl = stage().controller;
  const audio = new Audio(CLIP);
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 512;
  ac.createMediaElementSource(audio).connect(an);
  an.connect(ac.destination);
  const buf = new Uint8Array(an.fftSize);
  // A context created before any interaction starts suspended, and output stays silent.
  if (ac.state === "suspended") await ac.resume().catch(() => {});
  try {
    await audio.play();
  } catch {
    void ac.close();
    return false;
  }
  if (ac.state === "suspended" || audio.paused) { void ac.close(); return false; }
  ctl.say(text, Math.max(3, audio.duration || text.length * 0.065), { linger: 3 });
  await new Promise<void>((done) => {
    const tick = () => {
      if (signal.cancelled() || audio.ended || audio.paused) { audio.pause(); void ac.close(); done(); return; }
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      ctl.override.mouthOpen = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return true;
}

/** The live agent, made to say exactly the line. False when it can't (no agent, mic not allowed, override off). */
async function liveAgent(text: string, signal: { cancelled: () => boolean }): Promise<boolean> {
  if (!AGENT_ID) return false;
  try {
    const mic = await navigator.permissions.query({ name: "microphone" as PermissionName });
    if (mic.state !== "granted") return false;
  } catch { return false; }
  const ctl = stage().controller;
  let convo: VoiceConversation | null = null;
  try {
    let spoke = false, ended = false;
    convo = await VoiceConversation.startSession({
      agentId: AGENT_ID,
      connectionType: "websocket",
      overrides: { agent: { firstMessage: text } },
      onModeChange: ({ mode }) => { if (mode === "speaking") spoke = true; else if (spoke) ended = true; },
      onDisconnect: () => { ended = true; },
    });
    convo.setMicMuted(true);
    ctl.say(text, Math.max(4, text.length * 0.065), { linger: 3 });
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const tick = () => {
        if (signal.cancelled() || ended || performance.now() - t0 > 30_000 || (!spoke && performance.now() - t0 > 6000)) { done(); return; }
        ctl.override.mouthOpen = Math.min(1, convo!.getOutputVolume() * 3.5);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return spoke;
  } catch {
    return false;
  } finally {
    void convo?.endSession();
  }
}

function waitFor(ms: number, signal: { cancelled: () => boolean }) {
  return new Promise<void>((done) => {
    const t0 = performance.now();
    const tick = () => (signal.cancelled() || performance.now() - t0 > ms ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}
