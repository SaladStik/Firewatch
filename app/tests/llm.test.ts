import { test } from "node:test";
import assert from "node:assert/strict";
import { askLlm, TOOL_SPECS } from "../src/firefly/llm.ts";
import { DATA_TOPICS, DISPATCH_ACTIONS } from "../src/firefly/topics.ts";

type Msg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };

/** Replace fetch with a scripted model: `reply(messages)` returns the next assistant message. */
function model(reply: (messages: Msg[], sent: { tools?: unknown[] }) => Msg | { status: number; error: string }) {
  const calls: { messages: Msg[]; tools?: unknown[] }[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Msg[]; tools?: unknown[] };
    calls.push(body);
    const r = reply(body.messages, body);
    if ("status" in r) return new Response(JSON.stringify({ error: r.error }), { status: r.status });
    return new Response(JSON.stringify({ message: r, model: "test-model" }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const toolCall = (name: string, args: object, id = "c1"): Msg => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("every tool the model can call exists in Firefly's tools, with the shared enums", async () => {
  const names = TOOL_SPECS.map((t) => t.function.name);
  for (const n of ["ask_data", "do_dispatch", "plan_crews", "plan_311", "fly_to", "set_forecast_day"]) assert.ok(names.includes(n), n);
  const ask = TOOL_SPECS.find((t) => t.function.name === "ask_data")!.function.parameters.properties as Record<string, { enum?: string[] }>;
  const act = TOOL_SPECS.find((t) => t.function.name === "do_dispatch")!.function.parameters.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(ask.topic.enum, [...DATA_TOPICS]);
  assert.deepEqual(act.action.enum, [...DISPATCH_ACTIONS]);
});

test("the model calls tools, reads their results and answers", async () => {
  const ran: unknown[] = [];
  const tools = { ask_data: async (p: unknown) => { ran.push(p); return JSON.stringify({ matching: 4, top: [{ id: "26-00216320" }] }); } };
  const calls = model((m) => (m.some((x) => x.role === "tool") ? { role: "assistant", content: "4 pothole tickets; 26-00216320 is first." } : toolCall("ask_data", { topic: "tickets", community: "Beltline" })));
  const a = await askLlm(tools as never, [], "potholes in Beltline?", { context: "Map day: today." });
  assert.equal(a.text, "4 pothole tickets; 26-00216320 is first.");
  assert.deepEqual(ran, [{ topic: "tickets", community: "Beltline" }]);
  assert.deepEqual(a.tools, ["ask_data: tickets"]);
  assert.equal(a.model, "test-model");
  // Second round trip carries the call and its result back to the model, with the tools offered.
  const second = calls[1].messages;
  assert.equal(second.at(-1)!.role, "tool");
  assert.equal(second.at(-1)!.tool_call_id, "c1");
  assert.ok(calls[0].tools && calls[0].tools.length === TOOL_SPECS.length);
  assert.match(String(second[0].content), /Now: /); // live context in the system prompt
});

test("a tool call written as JSON text is still run", async () => {
  let ran = false;
  const tools = { ask_data: async () => { ran = true; return JSON.stringify({ sources: ["a", "b"] }); } };
  model((m) => (m.some((x) => x.role === "tool") ? { role: "assistant", content: "Two sources." } : { role: "assistant", content: '{"name": "ask_data", "parameters": {"topic": "data_sources"}}' }));
  const a = await askLlm(tools as never, [], "what data do you use?");
  assert.ok(ran);
  assert.equal(a.text, "Two sources.");
});

test("unknown tools and bad arguments come back as errors, not crashes", async () => {
  const calls = model((m) => (m.some((x) => x.role === "tool") ? { role: "assistant", content: "Sorry." } : { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "nope", arguments: "{bad" } }] }));
  const a = await askLlm({} as never, [], "do something");
  assert.equal(a.text, "Sorry.");
  assert.match(String(calls[1].messages.at(-1)!.content), /No tool nope/);
});

test("a model that keeps calling tools is stopped and asked to answer", async () => {
  const calls = model((_m, sent) => (sent.tools ? toolCall("ask_data", { topic: "fleet" }) : { role: "assistant", content: "Here's what I found." }));
  const a = await askLlm({ ask_data: async () => "{}" } as never, [], "loop");
  assert.equal(a.text, "Here's what I found.");
  assert.equal(calls.length, 7); // six rounds with tools, then one without
});

test("model errors reject (so Firefly falls back to its own answers)", async () => {
  model(() => ({ status: 502, error: "Model 500: boom" }));
  await assert.rejects(askLlm({} as never, [], "hi"), /boom/);
});

test("the model's tools are the voice agent's tools (AGENT.md)", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(new URL("../src/firefly/AGENT.md", import.meta.url), "utf8");
  const agent = [...md.matchAll(/^\| (\w+) \|/gm)].map((m) => m[1]).filter((n) => n !== "name").sort();
  assert.deepEqual(TOOL_SPECS.map((t) => t.function.name).sort(), agent);
});
