/** Plays an Ask reply through the server's ElevenLabs route. */
const SERVER = ((import.meta.env.VITE_DATA_SERVER as string | undefined) ?? "").trim();
const SPEAK_URL = import.meta.env.DEV
  ? "/api/speak"
  : !SERVER
    ? ""
    : /^https?:\/\//.test(SERVER)
      ? `${SERVER.replace(/\/+$/, "")}/api/speak`
      : "/api/speak";

export type VoiceResult = "ok" | "stale" | "missing" | "bad_key" | "missing_permission" | "paid_voice" | "failed";

let generation = 0;
let ctx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;

function cut() {
  if (!source) return;
  try { source.stop(); } catch { /* already finished */ }
  source = null;
}

/** Call this from the click or submit that should be allowed to play audio. */
export function unlockVoice() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
}

export function stopVoice() {
  generation += 1;
  cut();
}

function forSpeech(text: string): string {
  return text
    .replace(/\bFWI\b/g, "fire weather index")
    .replace(/\bkm\/h\b/g, "kilometres an hour")
    .replace(/\bkm\b/g, "kilometres")
    .replace(/\bmm\b/g, "millimetres")
    .replace(/\s+/g, " ")
    .trim();
}

export async function voiceReady(): Promise<"ready" | "missing" | "unknown"> {
  if (!SPEAK_URL) return "unknown";
  try {
    const res = await fetch(SPEAK_URL);
    if (!res.ok) return "unknown";
    const body = await res.json() as { ready?: boolean };
    return body.ready ? "ready" : "missing";
  } catch {
    return "unknown";
  }
}

export async function speak(text: string): Promise<VoiceResult> {
  const spoken = forSpeech(text);
  if (!spoken || !SPEAK_URL) return "failed";
  unlockVoice();
  const id = ++generation;
  cut();
  const audio = ctx;
  if (!audio) return "failed";

  let res: Response;
  try {
    res = await fetch(SPEAK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken }),
    });
  } catch {
    return id === generation ? "failed" : "stale";
  }
  if (id !== generation) return "stale";
  if (res.status === 503) return "missing";
  if (res.status === 401) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    if (id !== generation) return "stale";
    return body?.error === "missing_permission" ? "missing_permission" : "bad_key";
  }
  if (res.status === 402) return "paid_voice";
  if (!res.ok) return "failed";

  const bytes = await res.arrayBuffer();
  if (id !== generation) return "stale";
  await audio.resume();
  const buffer = await audio.decodeAudioData(bytes.slice(0));
  if (id !== generation) return "stale";
  const node = audio.createBufferSource();
  node.buffer = buffer;
  node.connect(audio.destination);
  source = node;
  node.onended = () => { if (source === node) source = null; };
  node.start();
  return "ok";
}
