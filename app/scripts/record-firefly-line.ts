/**
 * Render Firefly's pitch line to public/pitch/firefly-answer.mp3.
 *
 * The pitch page plays this clip and drives his mouth from its waveform
 * (src/pitch/fireflyBeat.ts). Without it the beat falls back to the live agent, which only
 * works if that browser already granted the microphone, and otherwise to a silent bubble.
 *
 *   ELEVENLABS_API_KEY=… npm run record:firefly
 *
 * The key is read from the environment or app/.env, and never written anywhere. Same voice as
 * the live agent (Jessica), so the recorded line matches Firefly's voice in a conversation.
 *
 * The text is fixed because the pitch replays fixed data; re-check it by running
 * `fireflyLine()` in the pitch page's console (src/pitch/story.ts exports it).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const OUT = join(APP, "public", "pitch", "firefly-answer.mp3");

/** Must match src/pitch/fireflyBeat.ts answerFor() for the replayed fire. */
const LINE =
  "HWF121, 47 kilometres northwest of Garden River. It's 1,000 hectares, crowning, and spreading "
  + "about 12 metres a minute. I'd send a unit crew from Fort McMurray and a skimmer group from "
  + "High Level. The first can be there in 49 minutes.";

/** Jessica, the voice the live ElevenLabs agent speaks with (AGENT.md), so the pitch sounds like Firefly. */
const VOICE = process.env.FIREFLY_PITCH_VOICE_ID || "r1KmysJdVYZjJCm4mL3b";
const MODEL = "eleven_flash_v2_5";

/** The key from the environment, or app/.env if it is only there. */
function apiKey(): string {
  const fromEnv = (process.env.ELEVENLABS_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const envFile = join(APP, ".env");
  if (!existsSync(envFile)) return "";
  const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("ELEVENLABS_API_KEY="));
  return (line?.slice("ELEVENLABS_API_KEY=".length) ?? "").trim();
}

const key = apiKey();
if (!key) {
  console.error("No ELEVENLABS_API_KEY (environment or app/.env). Get one at");
  console.error("https://elevenlabs.io/app/settings/api-keys — it needs text-to-speech permission.");
  process.exit(1);
}

console.log(`Voice ${VOICE}, model ${MODEL}`);
console.log(`Line:  ${LINE}`);

const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
  method: "POST",
  headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
  body: JSON.stringify({ text: LINE, model_id: MODEL }),
  signal: AbortSignal.timeout(60_000),
});

if (!res.ok) {
  const detail = (await res.text()).slice(0, 300);
  // The page checks the content type, so a saved error page would look like a missing clip.
  console.error(`ElevenLabs ${res.status}: ${detail}`);
  if (res.status === 401) console.error("The key is wrong, or lacks text-to-speech permission.");
  process.exit(1);
}

const audio = Buffer.from(await res.arrayBuffer());
// An MP3 starts with an ID3 tag or a frame sync; anything else is not audio and must not be saved.
const looksLikeMp3 = audio.subarray(0, 3).toString("latin1") === "ID3" || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
if (!looksLikeMp3) {
  console.error(`That was not an mp3 (${audio.length} bytes starting ${audio.subarray(0, 8).toString("hex")}).`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, audio);
console.log(`\nWrote ${OUT} (${(audio.length / 1024).toFixed(0)} KB).`);
console.log("Open /pitch.html and he should say it. Commit the file so the deployed site has it.");
