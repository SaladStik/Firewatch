/**
 * Firefly's reasoning model, through the data server: Databricks Model Serving (a Foundation Model
 * API endpoint, OpenAI-compatible chat with tool calling). The browser runs the tools against the
 * map's own state (src/firefly/llm.ts); this only holds the credential and forwards the chat, so the
 * workspace token never reaches a web page.
 *
 * Environment (any one way to authenticate):
 *   DATABRICKS_HOST            workspace, e.g. https://dbc-….cloud.databricks.com (Databricks Apps sets it)
 *   DATABRICKS_TOKEN           a personal access token, or
 *   DATABRICKS_CLIENT_ID/_SECRET  a service principal (Databricks Apps sets these for the app itself;
 *                              give the app "Can query" on the serving endpoint)
 *   FIREWATCH_AI_ENDPOINT      serving endpoint name (default databricks-meta-llama-3-3-70b-instruct)
 *   FIREWATCH_AI_URL           any other OpenAI-compatible chat completions URL instead of Databricks
 *   FIREWATCH_AI_TOKEN         its bearer token
 */
const ENDPOINT = process.env.FIREWATCH_AI_ENDPOINT || "databricks-meta-llama-3-3-70b-instruct";
const HOST = (process.env.DATABRICKS_HOST ?? "").trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)(?=.)/, "https://");
const CUSTOM_URL = (process.env.FIREWATCH_AI_URL ?? "").trim();

/** Where chat requests go, or "" when no model is configured. */
const URL_ = CUSTOM_URL || (HOST && (process.env.DATABRICKS_TOKEN || process.env.DATABRICKS_CLIENT_ID) ? `${HOST}/serving-endpoints/${ENDPOINT}/invocations` : "");
const MODEL = CUSTOM_URL ? process.env.FIREWATCH_AI_MODEL || "custom" : ENDPOINT;

/** Bounds per request: a chat is a handful of turns plus tool results, never megabytes. */
export const AI_MAX_BODY = 256 * 1024;
const MAX_MESSAGES = 60;
const MAX_TOKENS = 1024;
/** Per device: enough for a conversation with tool calls, not enough to run up a bill. */
const PER_MINUTE = 40;
const TIMEOUT_MS = 45_000;

let cached: { token: string; expires: number } | null = null;
async function token(): Promise<string> {
  if (CUSTOM_URL) return process.env.FIREWATCH_AI_TOKEN ?? "";
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  const now = Date.now();
  if (cached && cached.expires > now + 60_000) return cached.token;
  const id = process.env.DATABRICKS_CLIENT_ID ?? "", secret = process.env.DATABRICKS_CLIENT_SECRET ?? "";
  const res = await fetch(`${HOST}/oidc/v1/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=all-apis",
  });
  if (!res.ok) throw new Error(`Databricks token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: b.access_token, expires: now + b.expires_in * 1000 };
  return cached.token;
}

export function aiStatus() {
  return { available: !!URL_, provider: CUSTOM_URL ? "custom" : "databricks", model: URL_ ? MODEL : null };
}

const recent = new Map<string, number[]>();
function allowed(ip: string) {
  const now = Date.now(), list = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= PER_MINUTE) { recent.set(ip, list); return false; }
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 5000) recent.clear(); // bounded memory
  return true;
}

interface ChatBody { messages?: unknown[]; tools?: unknown[] }

/** One model turn: the message it returns (text, or tool calls for the page to run). */
export async function aiChat(raw: string, ip: string): Promise<{ status: number; body: unknown }> {
  if (!URL_) return { status: 503, body: { error: "No AI model is configured on the data server (set DATABRICKS_HOST and a token)." } };
  if (!allowed(ip)) return { status: 429, body: { error: "Too many AI requests from this device; wait a minute." } };
  let req: ChatBody;
  try { req = JSON.parse(raw) as ChatBody; } catch { return { status: 400, body: { error: "Bad JSON" } }; }
  if (!Array.isArray(req.messages) || !req.messages.length || req.messages.length > MAX_MESSAGES) return { status: 400, body: { error: `messages: 1 to ${MAX_MESSAGES}` } };
  const payload = {
    ...(CUSTOM_URL ? { model: MODEL } : {}),
    messages: req.messages,
    ...(Array.isArray(req.tools) && req.tools.length ? { tools: req.tools.slice(0, 32), tool_choice: "auto" } : {}),
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { status: 502, body: { error: `Model ${res.status}: ${text.slice(0, 300)}` } };
    const out = JSON.parse(text) as { choices?: { message?: unknown; finish_reason?: string }[]; usage?: unknown };
    const choice = out.choices?.[0];
    if (!choice?.message) return { status: 502, body: { error: "The model returned no message." } };
    return { status: 200, body: { message: choice.message, finish: choice.finish_reason ?? null, model: MODEL } };
  } catch (e) {
    return { status: 502, body: { error: ctl.signal.aborted ? "The model took too long." : (e as Error).message } };
  } finally {
    clearTimeout(timer);
  }
}
