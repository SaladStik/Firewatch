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
import { activeFires, nearestPlaceText, threatsFor } from "./facts";
import { fireflyController, flyFireflyTo, showFirefly } from "./mascot";
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

/** Expressive voices may tag delivery ("[laughs]"); keep those out of the bubble. */
const clean = (t: string) => t.replace(/\[[a-z ]{2,24}\]\s*/gi, "").trim();

export function useFireflyAgent(engine: Engine | null) {
  const [history, setHistory] = useState<ChatLine[]>([]);
  const [pendingAlert, setPendingAlert] = useState<Alert | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [muted, setMuted] = useState(true);
  const toolsRef = useRef<ReturnType<typeof makeTools> | null>(null);
  /** Ambient mood from the last situation check; restored after each reply. */
  const moodRef = useRef<MoodName>("happy");
  /** Messages typed before the session finished connecting; sent on connect. */
  const queue = useRef<string[]>([]);
  const push = (line: ChatLine) => setHistory((h) => [...h.slice(-40), line]);

  const convo = useConversation({
    micMuted: muted,
    volume: voiceOn ? 1 : 0,
    onConnect: () => { for (const t of queue.current.splice(0)) convoRef.current.sendUserMessage(t); },
    onMessage: (m) => {
      if (m.role !== "agent") return;
      const text = clean(m.message);
      if (!text) return;
      push({ from: "firefly", text });
      const ctl = fireflyController();
      ctl.say(text, Math.max(3, text.length * 0.07));
      ctl.setMood(moodRef.current);
    },
    onError: (message) => push({ from: "alert", text: `Firefly hit a problem (${String(message)}).` }),
  });
  // The hook returns a new object every render: callbacks and effects read the latest through this ref.
  const convoRef = useRef(convo);
  useLayoutEffect(() => { convoRef.current = convo; });
  const connected = convo.status === "connected";

  // Show him once the engine exists.
  useEffect(() => {
    if (!engine) return;
    showFirefly();
    toolsRef.current = makeTools(engine);
  }, [engine]);

  // Mouth follows the voice; released when silent.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const c = convoRef.current, ctl = fireflyController();
      if (c.status === "connected" && c.isSpeaking) ctl.override.mouthOpen = Math.min(1, c.getOutputVolume() * 3.5);
      else if ("mouthOpen" in ctl.override) delete ctl.override.mouthOpen;
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
    if (!text.trim()) return;
    push({ from: "you", text });
    fireflyController().setMood("thinking");
    deliver(text);
  }, [deliver]);

  const holdTalk = useCallback((down: boolean) => {
    if (down) deliver();
    setMuted(!down);
  }, [deliver]);

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
    available: Boolean(AGENT_ID), status: convo.status, connected, speaking: convo.isSpeaking, history,
    send, holdTalk, voiceOn, toggleVoice, pendingAlert, askAboutAlert, end: () => convo.endSession(),
  };
}
