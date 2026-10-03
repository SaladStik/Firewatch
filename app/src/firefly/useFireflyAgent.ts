/**
 * Firefly's live session (ElevenLabs Agent): starts on first use, mic muted unless the talk
 * button is held, typed messages get spoken answers. Mirrors the agent's replies into the
 * mascot's speech bubble, drives his mouth from the voice volume, keeps a short history, and
 * delivers monitor alerts (spoken when connected, bubble-only otherwise).
 */
import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { weatherAt } from "../data/openMeteo";
import type { Engine } from "../engine";
import type { MoodName } from "../mascot/firefly";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { answerLocally } from "../agent/tools";
import { answerDispatch, isDispatchQuestion } from "../dispatch/agent";
import { answerKnowledge } from "./knowledgeAsk";
import { UNKNOWN_REPLY } from "../agent/reply";
import { activeFires, nearestPlaceText, threatsFor } from "./facts";
import { fireflyAway, fireflyController, flyFireflyHome, flyFireflyTo, keepFireflyShown, showFirefly } from "./mascot";
import { diffAlerts, situationMood, type Alert, type Watch } from "./monitor";
import { llmContext, makeTools, snapshot } from "./tools";
import { askLlm, llmStatus, type LlmMessage } from "./llm";

export const AGENT_ID = import.meta.env.VITE_ELEVENLABS_AGENT_ID ?? "";

/** `via`: which AI answered and the tools it used, shown under the reply. */
export interface ChatLine { from: "you" | "firefly" | "alert"; text: string; via?: string }

function buildWatch(): Watch {
  const s = snapshot();
  const threats = threatsFor(s, s.forecastDay);
  return {
    fires: activeFires(s).map((f) => ({ id: f.fid, lat: f.lat, lng: f.lng, near: nearestPlaceText(s, f.lat, f.lng) })),
    threatened: threats.map((t) => ({ place: t.place.name, reason: t.reason, lat: t.place.lat, lng: t.place.lng })),
    extremeTomorrow: threats
      .filter((t) => weatherAt(s.weather, t.place.lat, t.place.lng)?.days[1]?.danger === "Extreme")
      .map((t) => ({ place: t.place.name, lat: t.place.lat, lng: t.place.lng })),
  };
}

/** Seconds of quiet after explaining before he flies back to the dock. */
const HOME_AFTER_S = 1.5;
/** How long each character stays in the bubble (s). Slower than the voice, so a line can be read. */
const SECS_PER_CHAR = 0.12;
/** Extra seconds the bubble stays after the line has been said. */
const READ_AFTER_S = 6;
/** With no audio for a queued line (voice off, text only), show it after this long (ms). */
const LINE_FALLBACK_MS = 1200;
/** How long to wait for the agent's first reply before answering from the data (ms). */
const AGENT_TIMEOUT_MS = 25_000;
/** After the model fails, try it again after this long (ms). */
const LLM_RETRY_MS = 60_000;
/** How long the mic stays open after the talk button is released (ms). */
const MIC_TAIL_MS = 600;

/** Expressive voices may tag delivery ("[laughs]"); keep those out of the bubble. */
const clean = (t: string) => t.replace(/\[[a-z ]{2,24}\]\s*/gi, "").trim();

export function useFireflyAgent(engine: Engine | null) {
  const [history, setHistory] = useState<ChatLine[]>([]);
  const [pendingAlert, setPendingAlert] = useState<Alert | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [showThreats, setShowThreats] = useState(false);
  const [muted, setMuted] = useState(true);
  const toolsRef = useRef<ReturnType<typeof makeTools> | null>(null);
  /** Ambient mood from the last situation check; restored after each reply. */
  const moodRef = useRef<MoodName>("idle");
  /** Messages typed before the session finished connecting; sent on connect. */
  const queue = useRef<string[]>([]);
  /** The agent failed (no network, quota, misconfigured): answer offline until it connects again. */
  const agentDown = useRef(false);
  /** The question the agent is working on, answered offline if the agent fails. */
  const pending = useRef("");
  /** answerOffline, for callbacks set up before it exists (onError, the reply timeout). */
  const answerOfflineRef = useRef<(q: string) => void>(() => {});
  /** Last typed message, so its transcript echo isn't shown twice. */
  const lastTyped = useRef("");
  /** Pending mic mute after the talk button is released. */
  const muteTimer = useRef(0);
  /** Agent lines waiting for their audio, so the bubble shows what he's saying, not what's coming. */
  const lines = useRef<{ text: string; at: number }[]>([]);
  const push = (line: ChatLine) => setHistory((h) => [...h.slice(-40), line]);
  /** The reasoning model on the data server (Databricks), if one is configured. */
  const [llm, setLlm] = useState<{ available: boolean; model: string | null }>({ available: false, model: null });
  useEffect(() => { void llmStatus().then(setLlm); }, []);
  /** What the model is doing right now ("ask_data: tickets"), or null when idle. */
  const [working, setWorking] = useState<string | null>(null);
  /** The model's conversation so far (text turns), so follow-ups like "dispatch it" have context. */
  const llmHistory = useRef<LlmMessage[]>([]);
  /** The model failed: use the voice agent / offline answers until then (ms timestamp). */
  const llmDownUntil = useRef(0);
  /** Questions to the model run one at a time, in order (each sees the answers before it). */
  const llmChain = useRef<Promise<void>>(Promise.resolve());
  /** answerElsewhere, for send (declared before it). */
  const answerElsewhereRef = useRef<(q: string) => void>(() => {});

  const convo = useConversation({
    micMuted: muted,
    volume: voiceOn ? 1 : 0,
    onConnect: () => { agentDown.current = false; for (const t of queue.current.splice(0)) convoRef.current.sendUserMessage(t); },
    onMessage: (m) => {
      const text = clean(m.message);
      if (!text) return;
      if (m.role === "user") {
        // What the mic heard (typed messages may be echoed back too; skip those).
        if (text !== lastTyped.current) { push({ from: "you", text }); fireflyController().setMood("thinking"); }
        lastTyped.current = "";
        return;
      }
      pending.current = "";
      push({ from: "firefly", text });
      lines.current.push({ text, at: performance.now() });
    },
    onInterruption: () => { lines.current = []; },
    onError: (message) => {
      // Fall back to answering from the app's data so the question isn't lost.
      agentDown.current = true;
      queue.current = [];
      const q = pending.current;
      pending.current = "";
      push({ from: "alert", text: `Firefly's AI isn't reachable (${String(message)}): answering from the map's data.` });
      if (q) answerOfflineRef.current(q);
    },
  });
  // The hook returns a new object every render: callbacks and effects read the latest through this ref.
  const convoRef = useRef(convo);
  useLayoutEffect(() => { convoRef.current = convo; });
  const connected = convo.status === "connected";

  // Prepare him once the map is up. He stays hidden until Ask is opened.
  const bootHidden = useStore(app, (s) => !!s.boot.hidden);
  useEffect(() => {
    if (!engine || !bootHidden) return;
    showFirefly();
    toolsRef.current = makeTools(engine);
    const unsubscribe = keepFireflyShown();
    return () => { unsubscribe(); };
  }, [engine, bootHidden]);

  // Mouth follows the voice; released when silent. Once he's done explaining (not speaking,
  // thinking, flying or showing a bubble) for HOME_AFTER_S, he flies back to the dock.
  useEffect(() => {
    let raf = 0;
    let quietSince = performance.now();
    let wasSpeaking = false, audioStarted = false, lineEndsAt = 0;
    const tick = () => {
      const c = convoRef.current, ctl = fireflyController();
      const speaking = c.status === "connected" && c.isSpeaking;
      // Bubble follows the voice: a queued line shows when its audio starts, when the line before it
      // has had time to be said, or (no audio: voice off / text) shortly after it arrived.
      if (speaking && !wasSpeaking) audioStarted = true;
      else if (!speaking) audioStarted = false;
      wasSpeaking = speaking;
      const next = lines.current[0];
      if (next) {
        const t = performance.now();
        if (audioStarted || (speaking && t > lineEndsAt) || (!speaking && t - next.at > LINE_FALLBACK_MS)) {
          lines.current.shift();
          audioStarted = false;
          const secs = Math.max(4, next.text.length * SECS_PER_CHAR);
          lineEndsAt = t + (secs + READ_AFTER_S) * 1000;
          ctl.say(next.text, secs, { linger: READ_AFTER_S });
          ctl.setMood(moodRef.current);
        }
      }
      if (speaking) ctl.override.mouthOpen = Math.min(1, c.getOutputVolume() * 3.5);
      else if ("mouthOpen" in ctl.override) delete ctl.override.mouthOpen;
      const now = performance.now();
      if (speaking || ctl.flying || ctl.speech || ctl.mood === "thinking" || !fireflyAway()) quietSince = now;
      else if (now - quietSince > HOME_AFTER_S * 1000) { quietSince = now; void flyFireflyHome(); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /** Start the session if needed; `text` is sent now, or on connect. */
  const deliver = useCallback((text?: string) => {
    const c = convoRef.current;
    if (c.status === "connected") { if (text) c.sendUserMessage(text); return; }
    if (text) queue.current.push(text);
    if (!AGENT_ID || !toolsRef.current || c.status !== "disconnected") return;
    c.startSession({ agentId: AGENT_ID, connectionType: "websocket", clientTools: toolsRef.current });
  }, []);

  /**
   * Answer without the model: the app's own data and dispatch commands (knowledge layer), then crew
   * planning, then map commands. Used only when the agent isn't configured or can't be reached.
   */
  const answerOffline = useCallback((trimmed: string) => {
    if (!engine) return;
    const ctl = fireflyController();
    const reply = (text: string, threats = false) => {
      push({ from: "firefly", text });
      setShowThreats(threats);
      ctl.say(text, Math.max(4, text.length * SECS_PER_CHAR), { linger: READ_AFTER_S });
      ctl.setMood(moodRef.current);
    };
    ctl.setMood("thinking");
    void (async () => {
      const text = await answerKnowledge(engine, trimmed);
      if (text) return reply(text);
      if (isDispatchQuestion(trimmed)) return reply((await answerDispatch(trimmed)) ?? "I couldn't plan that one.");
      const local = answerLocally(engine, trimmed);
      if (local) return reply(local.reply, local.threats);
      reply(UNKNOWN_REPLY);
    })().catch((e) => reply(`I couldn't get that: ${e instanceof Error ? e.message : String(e)}`));
  }, [engine]);

  /**
   * Firefly's AI answers whenever it's available. Typed: the reasoning model on Databricks (through
   * the data server) plans and calls the tools (ask_data, do_dispatch, plan_crews, …) itself; without
   * it, the ElevenLabs agent; without either, the same tools answer directly (answerOffline).
   * Spoken questions always go to the ElevenLabs agent.
   */
  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !engine) return;
    setShowThreats(false);
    push({ from: "you", text: trimmed });
    // Typed questions: the reasoning model with Firefly's tools, when the data server has one.
    if (llm.available && Date.now() > llmDownUntil.current && toolsRef.current) {
      const tools = toolsRef.current, ctl = fireflyController();
      ctl.setMood("thinking");
      setWorking("Thinking");
      llmChain.current = llmChain.current.then(() => (Date.now() < llmDownUntil.current
        ? Promise.resolve(answerElsewhereRef.current(trimmed)) // the model failed on an earlier question
        : askLlm(tools, llmHistory.current, trimmed, { context: llmContext(), onStep: (step) => setWorking(step) })
        .then((a) => {
          llmHistory.current = [...llmHistory.current, { role: "user" as const, content: trimmed }, { role: "assistant" as const, content: a.text }].slice(-12);
          push({ from: "firefly", text: a.text, via: `${a.model}${a.tools.length ? ` · ${a.tools.join(", ")}` : ""}` });
          ctl.say(a.text, Math.max(4, a.text.length * SECS_PER_CHAR), { linger: READ_AFTER_S });
          ctl.setMood(moodRef.current);
        })
        .catch((e) => {
          llmDownUntil.current = Date.now() + LLM_RETRY_MS;
          push({ from: "alert", text: `Firefly's AI model isn't answering (${e instanceof Error ? e.message : String(e)}).` });
          answerElsewhereRef.current(trimmed);
        })))
        .finally(() => setWorking(null));
      return;
    }
    answerElsewhereRef.current(trimmed);
  }, [engine, llm.available]);

  /** Without the model: the voice agent (typed), or the app's own answers. */
  const answerElsewhere = useCallback((trimmed: string) => {
    if (!AGENT_ID || agentDown.current) { answerOffline(trimmed); return; }
    lastTyped.current = clean(trimmed);
    pending.current = trimmed;
    fireflyController().setMood("thinking");
    deliver(trimmed);
    // No answer from the agent in time (stalled session, missing tool): answer from the data instead.
    window.setTimeout(() => {
      if (pending.current !== trimmed) return;
      pending.current = "";
      push({ from: "alert", text: "Firefly's AI is taking too long: answering from the map's data." });
      answerOfflineRef.current(trimmed);
    }, AGENT_TIMEOUT_MS);
  }, [deliver, answerOffline]);

  /** Hold to talk. The mic stays open a moment after release so the last word isn't cut off. */
  const holdTalk = useCallback((down: boolean) => {
    clearTimeout(muteTimer.current);
    if (down) { deliver(); setMuted(false); return; }
    muteTimer.current = window.setTimeout(() => setMuted(true), MIC_TAIL_MS);
  }, [deliver]);

  /** Mic input level 0..1 (for the talk button's ring). */
  const inputLevel = useCallback(() => {
    const c = convoRef.current;
    return c.status === "connected" ? c.getInputVolume() : 0;
  }, []);

  useLayoutEffect(() => { answerOfflineRef.current = answerOffline; answerElsewhereRef.current = answerElsewhere; });

  const toggleVoice = useCallback(() => setVoiceOn((v) => !v), []);

  // Monitor: diff after every data/forecast refresh; deliver the first new alert.
  useEffect(() => {
    if (!engine) return;
    let prev: Watch | null = null;
    let lastKey = "";
    const seen = new Set<string>();
    const unsubscribe = app.subscribe(() => {
      const s = app.get();
      const key = `${s.dataStatus.at}|${s.forecastDay}|${s.simulation}|${s.spread?.cells.length ?? 0}|${s.hotspots.length}|${s.weather.length}`;
      if (key === lastKey || !s.weather.length) return;
      lastKey = key;
      const next = buildWatch();
      moodRef.current = situationMood(next);
      const ctl = fireflyController();
      if (!convoRef.current.isSpeaking) ctl.setMood(moodRef.current);
      const alerts = diffAlerts(prev, next).filter((a) => !seen.has(a.key));
      prev = next;
      alerts.forEach((a) => seen.add(a.key));
      const a = alerts[0];
      if (!a) return;
      engine.flyToLatLng(a.lat, a.lng, 40);
      void flyFireflyTo(engine, a.lat, a.lng);
      ctl.setMood("alert");
      push({ from: "alert", text: a.text });
      const c = convoRef.current;
      if (c.status === "connected" && !c.isSpeaking) c.sendUserMessage(`[ALERT] ${a.text}`);
      else { ctl.say(a.text, Math.max(4, a.text.length * SECS_PER_CHAR), { linger: READ_AFTER_S }); setPendingAlert(a); }
    });
    return () => { unsubscribe(); };
  }, [engine]);

  const askAboutAlert = useCallback(() => {
    if (!pendingAlert) return;
    setPendingAlert(null);
    deliver(`[ALERT] ${pendingAlert.text}`);
  }, [pendingAlert, deliver]);

  return {
    available: Boolean(AGENT_ID), model: llm.available ? llm.model : null, working, status: convo.status, connected, speaking: convo.isSpeaking, history, showThreats,
    send, holdTalk, inputLevel, voiceOn, toggleVoice, pendingAlert, askAboutAlert, end: () => convo.endSession(),
  };
}
