/** ElevenLabs speech for the Ask panel. The key stays on the server. */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_VOICE = "NOpBlnGInO9m6vDvFkFC";
const MODEL = "eleven_flash_v2_5";
const MAX_CHARS = 700;
const MAX_BODY = 8_000;

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

export interface SpeakResult {
  status: number;
  type: string;
  body: Buffer;
}

function json(status: number, value: unknown): SpeakResult {
  const body = Buffer.from(JSON.stringify(value));
  return { status, type: "application/json; charset=utf-8", body };
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cut = trimmed.indexOf("=");
    if (cut < 1) continue;
    let value = trimmed.slice(cut + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, cut).trim()] = value;
  }
  return out;
}

function voiceIdOf(file: string): { key: string; voiceId: string } {
  const saved = readEnvFile(file);
  const key = (process.env.ELEVENLABS_API_KEY || saved.ELEVENLABS_API_KEY || "").trim();
  const raw = (process.env.ELEVENLABS_VOICE_ID || saved.ELEVENLABS_VOICE_ID || DEFAULT_VOICE).trim();
  const voiceId = /^[A-Za-z0-9]{10,40}$/.test(raw) ? raw : DEFAULT_VOICE;
  return { key, voiceId };
}

/** Collapse whitespace and keep the reply inside the character cap. */
export function clipSpeech(text: string, max = MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (stop >= 0) return cut.slice(0, stop + 1).trim();
  return cut.trim();
}

export function prepareSpeech(text: string, key: string): { error: "missing_key" | "empty" } | { text: string } {
  if (!key.trim()) return { error: "missing_key" };
  const clipped = clipSpeech(text);
  if (!clipped) return { error: "empty" };
  return { text: clipped };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function speakFromRequest(req: IncomingMessage, envFile = ENV_FILE): Promise<SpeakResult> {
  const { key, voiceId } = voiceIdOf(envFile);
  if (req.method === "GET") return json(200, { ready: Boolean(key) });

  let text = "";
  try {
    const raw = JSON.parse(await readBody(req)) as { text?: unknown };
    text = typeof raw.text === "string" ? raw.text : "";
  } catch {
    return json(400, { error: "bad_request" });
  }

  const prepared = prepareSpeech(text, key);
  if ("error" in prepared) {
    const status = prepared.error === "missing_key" ? 503 : 400;
    return json(status, { error: prepared.error });
  }

  let res: Response;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text: prepared.text, model_id: MODEL }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    console.warn("[voice] ElevenLabs request failed");
    return json(502, { error: "upstream" });
  }

  if (!res.ok) {
    const detail = await res.text();
    console.warn(`[voice] ElevenLabs ${res.status}`);
    if (res.status === 401) {
      const error = detail.includes("text_to_speech") ? "missing_permission" : "bad_key";
      return json(401, { error });
    }
    if (res.status === 402) return json(402, { error: "paid_voice" });
    return json(502, { error: "upstream" });
  }

  return { status: 200, type: "audio/mpeg", body: Buffer.from(await res.arrayBuffer()) };
}
