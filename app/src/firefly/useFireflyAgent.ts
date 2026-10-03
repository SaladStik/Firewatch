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
import { UNKNOWN_REPLY } from "../agent/reply";
import { activeFires, nearestPlaceText, threatsFor } from "./facts";
import { fireflyAway, fireflyController, flyFireflyHome, flyFireflyTo, keepFireflyShown, showFirefly } from "./mascot";
import { diffAlerts, situationMood, type Alert, type Watch } from "./monitor";
import { makeTools, snapshot } from "./tools";

export const AGENT_ID = import.meta.env.VITE_ELEVENLABS_AGENT_ID ?? "";

export interface ChatLine { from: "you" | "firefly" | "alert"; text: string }

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
/** Rough speaking rate of the voice (s per character), to pace the bubble through queued lines. */
const SECS_PER_CHAR = 0.065;
/** With no audio for a queued line (voice off, text only), show it after this long (ms). */
const LINE_FALLBACK_MS = 1200;
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
  const moodRef = useRef<MoodName>("happy");
  /** Messages typed before the session finished connecting; sent on connect. */
  const queue = useRef<string[]>([]);
  /** Last typed message, so its transcript echo isn't shown twice. */
  const lastTyped = useRef("");
  /** Pending mic mute after the talk button is released. */
  const muteTimer = useRef(0);
  /** Agent lines waiting for their audio, so the bubble shows what he's saying, not what's coming. */
  const lines = useRef<{ text: string; at: number }[]>([]);
  const push = (line: ChatLine) => setHistory((h) => [...h.slice(-40), line]);

  const convo = useConversation({
    micMuted: muted,
    volume: voiceOn ? 1 : 0,
    onConnect: () => { for (const t of queue.current.splice(0)) convoRef.current.sendUserMessage(t); },
    onMessage: (m) => {
      const text = clean(m.message);
      if (!text) return;
      if (m.role === "user") {
        // What the mic heard (typed messages may be echoed back too; skip those).
        if (text !== lastTyped.current) { push({ from: "you", text }); fireflyController().setMood("thinking"); }
        lastTyped.current = "";
        return;
      }
      push({ from: "firefly", text });
      lines.current.push({ text, at: performance.now() });
    },
    onInterruption: () => { lines.current = []; },
    onError: (message) => push({ from: "alert", text: `Firefly hit a problem (${String(message)}).` }),
  });
  // The hook returns a new object every render: callbacks and effects read the latest through this ref.
  const convoRef = useRef(convo);
  useLayoutEffect(() => { convoRef.current = convo; });
  const connected = convo.status === "connected";

  // Show him once the map is up and the loading screen has faded out.
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
          const secs = Math.max(2, next.text.length * SECS_PER_CHAR);
          lineEndsAt = t + secs * 1000;
          ctl.say(next.text, secs + 0.5);
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

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !engine) return;
    const local = answerLocally(engine, trimmed);
    if (local) {
      push({ from: "you", text: trimmed });
      push({ from: "firefly", text: local.reply });
      setShowThreats(local.threats);
      const ctl = fireflyController();
      ctl.say(local.reply, Math.max(3, Math.min(12, local.reply.length * 0.05)));
      ctl.setMood(moodRef.current);
      return;
    }
    setShowThreats(false);
    push({ from: "you", text: trimmed });
    if (!AGENT_ID) {
      push({ from: "firefly", text: UNKNOWN_REPLY });
      return;
    }
    lastTyped.current = clean(trimmed);
    fireflyController().setMood("thinking");
    deliver(trimmed);
  }, [deliver, engine]);

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
      else { ctl.say(a.text, 6); setPendingAlert(a); }
    });
    return () => { unsubscribe(); };
  }, [engine]);

  const askAboutAlert = useCallback(() => {
    if (!pendingAlert) return;
    setPendingAlert(null);
    deliver(`[ALERT] ${pendingAlert.text}`);
  }, [pendingAlert, deliver]);

  return {
    available: Boolean(AGENT_ID), status: convo.status, connected, speaking: convo.isSpeaking, history, showThreats,
    send, holdTalk, inputLevel, voiceOn, toggleVoice, pendingAlert, askAboutAlert, end: () => convo.endSession(),
  };
}
