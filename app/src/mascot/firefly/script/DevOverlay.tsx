/**
 * Firefly dev overlay — record / edit / play mascot scripts on ANY page.
 *
 * Enable: dev builds automatically, or add ?fireflydev to any URL (remembered).
 * Toggle: Ctrl+Shift+F, or the small FF button bottom-left.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EMOTE_DURATION, type EmoteName } from "../controller";
import { MOOD_NAMES, MOODS, type MoodName } from "../moods";
import { anchorAt, areaForElement, areaFromBox, viewportAnchor } from "./anchors";
import { describeStep, execStep, prepareAt, sayDuration, smoothScript } from "./player";
import { getStage } from "./stage";
import { EASES, EMPTY_SCRIPT, type Ease, type FireflyScript, type ScriptStep, type TaskAction } from "./types";

const EMOTES = Object.keys(EMOTE_DURATION) as EmoteName[];
const STORAGE = "firefly.dev.script";

export function isFireflyDevEnabled(): boolean {
  try {
    if (new URLSearchParams(location.search).has("fireflydev")) localStorage.setItem("firefly.dev", "1");
    return import.meta.env.DEV || localStorage.getItem("firefly.dev") === "1";
  } catch {
    return import.meta.env.DEV;
  }
}

let mounted = false;
/** Mount the overlay on the current page (no-op unless enabled). Call once from any entry point. */
export function mountFireflyDev() {
  if (mounted || !isFireflyDevEnabled()) return;
  mounted = true;
  getStage(); // create the stage layer first (never during a React render)
  const host = document.createElement("div");
  host.setAttribute("data-firefly-ui", "dev");
  Object.assign(host.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483001" });
  document.body.appendChild(host);
  createRoot(host).render(<DevOverlay />);
}

type Pick = null | "fly" | "look" | "show" | "start" | "spot" | "task" | "taskel";

/** What counts as "the thing to click / type in" when picking a task element. */
const INTERACTIVE = "input, textarea, select, button, a, [role=button], [data-tour], label";

function loadSaved(): FireflyScript {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
    if (s?.version === 1) return s;
  } catch { /* ignore */ }
  return structuredClone(EMPTY_SCRIPT);
}

function DevOverlay() {
  const stage = getStage();
  const ctl = stage.controller;
  const [open, setOpen] = useState(false);
  const [script, setScript] = useState<FireflyScript>(loadSaved);
  const [recording, setRecording] = useState(false);
  const [timing, setTiming] = useState(true);
  const [pick, setPick] = useState<Pick>(null);
  const [mood, setMood] = useState<MoodName>("happy");
  const [text, setText] = useState("Hi! Let me show you around.");
  const [wait, setWait] = useState(1);
  const [playing, setPlaying] = useState(-1);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [toast, setToast] = useState("");
  const [shape, setShape] = useState<"rect" | "ellipse">("rect");
  const [spotClick, setSpotClick] = useState(true);
  const [taskAction, setTaskAction] = useState<TaskAction>("click");
  const [expect, setExpect] = useState("");
  const [sizeTo, setSizeTo] = useState(0.16);
  const [sizeSecs, setSizeSecs] = useState(0.8);
  const [sizeEase, setSizeEase] = useState<Ease>("easeInOut");
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Step-through cursor: the next step "Step ›" will run. */
  const [cursor, setCursor] = useState(0);
  const [stepBusy, setStepBusy] = useState(false);
  const idleSince = useRef(performance.now());
  const panelPos = useDraggable("firefly.dev.panel", { x: 12, y: 60 });
  const run = useRef<{ stop: () => void } | null>(null);

  // Persist the working script so a page reload doesn't lose it.
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(script)); } catch { /* full */ } }, [script]);

  // Ctrl+Shift+F toggles the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setPick(null);
    };
    const onToggle = () => setOpen((o) => !o);
    addEventListener("keydown", onKey);
    addEventListener("firefly-dev-toggle", onToggle);
    return () => { removeEventListener("keydown", onKey); removeEventListener("firefly-dev-toggle", onToggle); };
  }, []);

  // Show the mascot while the panel is open (unless a script is hiding him).
  useEffect(() => {
    if (open) stage.setVisible(true);
    else if (!stage.playing) stage.setVisible(false);
  }, [open, stage]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 1600); };

  /**
   * Do an action live AND append it to the script (every panel action becomes a step, so the
   * copied JSON always has everything). While recording, the idle gap before it is kept as a wait.
   */
  const act = (step: ScriptStep) => {
    const gap = (performance.now() - idleSince.current) / 1000;
    setScript((s) => ({
      ...s,
      steps: [...s.steps, ...(recording && timing && gap > 0.3 && step.type !== "wait" ? [{ type: "wait" as const, seconds: Math.round(gap * 10) / 10 }] : []), step],
    }));
    const started = performance.now();
    idleSince.current = Infinity; // busy until the step finishes
    void execStep(ctl, step, script, stage.hooks()).then(() => {
      idleSince.current = Math.max(performance.now(), started);
    });
  };

  /** Start capturing pauses. Keeps existing steps (use Clear to start over); an empty script starts where he is. */
  const startRecording = () => {
    stage.stop();
    stage.setVisible(true);
    if (!script.steps.length) setScript((s) => ({ ...s, start: viewportAnchor(ctl.pose.x, ctl.pose.y), size: stage.get().size }));
    idleSince.current = performance.now();
    setRecording(true);
    flash("Recording: pauses between actions are kept as waits");
  };

  const play = (from = 0) => {
    setRecording(false);
    run.current?.stop();
    const r = stage.play(script, { from, onStep: (i) => setPlaying(i) });
    run.current = r;
    void r.done.then(() => { setPlaying(-1); stage.setVisible(open || false); });
  };

  /** Run exactly one step (the cursor), then advance. First press prepares the start state. */
  const stepOnce = async () => {
    if (stepBusy || !script.steps.length) return;
    setRecording(false);
    run.current?.stop();
    const i = cursor >= script.steps.length ? 0 : cursor;
    if (i === 0 || playing === -1) prepareAt(ctl, script, i, stage.hooks());
    setPlaying(i);
    setStepBusy(true);
    await execStep(ctl, script.steps[i], script, stage.hooks());
    setStepBusy(false);
    setCursor(i + 1);
    if (i + 1 >= script.steps.length) { setPlaying(-1); flash("End of script"); }
  };

  const stopAll = () => { run.current?.stop(); stage.stop(); setPlaying(-1); setCursor(0); setStepBusy(false); stage.setVisible(true); };

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(script, null, 2));
    flash("Script copied to clipboard");
  };

  const doImport = () => {
    try {
      const s = JSON.parse(importText);
      if (s?.version !== 1 || !Array.isArray(s.steps)) throw new Error("not a Firefly script");
      setScript(s);
      setImporting(false);
      flash(`Loaded ${s.steps.length} steps`);
    } catch (e) {
      flash(`Import failed: ${(e as Error).message}`);
    }
  };

  const finishSpot = () => {
    if (!drag) return;
    const { x0, y0, x1, y1 } = drag;
    const kind = pick;
    setDrag(null);
    setPick(null);
    if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) { flash("Drag a box around the thing to highlight"); return; }
    const area = areaFromBox(x0, y0, x1, y1);
    if (kind === "task") act(taskStep(area, taskAction));
    else act({ type: "spotlight", area, shape, text: text.trim() || undefined, click: spotClick || undefined });
  };

  /** A hands-on task step from the panel's settings (Say text = what the firefly says). */
  const taskStep = (area: ReturnType<typeof areaFromBox>, action: TaskAction): ScriptStep => ({
    type: "task", area, action, shape,
    expect: action === "type" && expect.trim() ? expect.trim() : undefined,
    text: text.trim() || undefined,
  });

  /** Task on a real element: highlight the clicked button / field (fields become "type" tasks). */
  const pickTaskElement = (x: number, y: number) => {
    const hit = document.elementsFromPoint(x, y).find((e) => !e.closest("[data-firefly-ui]"));
    const el = hit?.closest(INTERACTIVE) ?? hit;
    if (!el) { flash("Nothing to highlight there"); return; }
    const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const action: TaskAction = isField ? "type" : "click";
    act(taskStep(areaForElement(el), action));
    flash(isField ? "Type task added: viewer must type here" : "Click task added: viewer must click here");
  };

  const onPick = (e: React.MouseEvent) => {
    if (pick === "spot" || pick === "task") return; // handled by drag
    const a = anchorAt(e.clientX, e.clientY);
    const kind = pick;
    setPick(null);
    if (kind === "fly") act({ type: "fly", to: a });
    if (kind === "look") act({ type: "look", at: a });
    if (kind === "show") act({ type: "show", at: a });
    if (kind === "taskel") { pickTaskElement(e.clientX, e.clientY); return; }
    if (kind === "start") { setScript((s) => ({ ...s, start: viewportAnchor(e.clientX, e.clientY) })); ctl.teleport(e.clientX, e.clientY); }
  };

  const edit = (i: number, patch: Partial<ScriptStep>) =>
    setScript((s) => ({ ...s, steps: s.steps.map((st, j) => (j === i ? ({ ...st, ...patch } as ScriptStep) : st)) }));
  const move = (i: number, d: number) =>
    setScript((s) => {
      const steps = [...s.steps];
      const j = i + d;
      if (j < 0 || j >= steps.length) return s;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...s, steps };
    });
  const remove = (i: number) => setScript((s) => ({ ...s, steps: s.steps.filter((_, j) => j !== i) }));

  return (
    <>
      {/* launcher */}
      <button data-firefly-ui onClick={() => setOpen((o) => !o)} title="Firefly scripts (Ctrl+Shift+F)" style={{ ...S.launcher, ...(recording ? S.rec : {}) }}>
        {recording ? "● REC" : "FF"}
      </button>

      {/* click-to-place layer */}
      {pick && (
        <div
          data-firefly-ui
          onClick={onPick}
          onPointerDown={pick === "spot" || pick === "task" ? (e) => {
            // Keep receiving the drag even if the pointer crosses other UI.
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
          } : undefined}
          onPointerMove={(pick === "spot" || pick === "task") && drag ? (e) => setDrag({ ...drag, x1: e.clientX, y1: e.clientY }) : undefined}
          onPointerUp={pick === "spot" || pick === "task" ? finishSpot : undefined}
          style={S.pickLayer}
        >
          <div style={S.pickHint}>
            {pick === "spot" || pick === "task" ? "Drag a box around what to highlight" : pick === "taskel" ? "Click the button / field the viewer must use" : `Click to ${pick === "fly" ? "fly here" : pick === "look" ? "look here" : pick === "show" ? "appear here" : "set the start point"}`} · Esc to cancel
          </div>
          {drag && (
            <div
              style={{
                position: "fixed", left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1),
                width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0),
                border: "2px dashed #37e3ff", borderRadius: shape === "ellipse" ? "50%" : 8, background: "rgba(55,227,255,.08)",
              }}
            />
          )}
        </div>
      )}

      {open && (
        <div ref={panelPos.ref} data-firefly-ui style={{ ...S.panel, left: panelPos.pos.x, top: panelPos.pos.y, ...(pick ? S.panelPicking : {}) }}>
          <div style={{ ...S.head, cursor: panelPos.dragging ? "grabbing" : "grab" }} onPointerDown={panelPos.onPointerDown} title="Drag to move">
            <b style={{ letterSpacing: ".18em", userSelect: "none" }}>⠿ FIREFLY // SCRIPT</b>
            <button style={S.x} onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)}>✕</button>
          </div>

          <Row>
            {recording
              ? <B on onClick={() => setRecording(false)}>■ Stop recording</B>
              : <B onClick={startRecording}>● Record</B>}
            <label style={S.check}><input type="checkbox" checked={timing} onChange={(e) => setTiming(e.target.checked)} /> capture pauses</label>
          </Row>
          <div style={{ fontSize: 10, color: "#5d7f90", marginTop: -2, marginBottom: 4 }}>
            Every action below is added to the script. Record also keeps the pauses between them. Copy JSON to save it.
          </div>

          <Label>Move</Label>
          <Row>
            <B on={pick === "fly"} onClick={() => setPick("fly")}>Fly to…</B>
            <B on={pick === "look"} onClick={() => setPick("look")}>Look at…</B>
            <B onClick={() => act({ type: "look", at: null })}>Look ahead</B>
          </Row>
          <Row>
            <B on={pick === "show"} onClick={() => setPick("show")}>Show at…</B>
            <B onClick={() => act({ type: "hide" })}>Hide</B>
            <B on={pick === "start"} onClick={() => setPick("start")}>Start point…</B>
          </Row>

          <Label>Mood</Label>
          <Row>
            <select value={mood} onChange={(e) => setMood(e.target.value as MoodName)} style={S.input}>
              {MOOD_NAMES.map((m) => <option key={m} value={m}>{MOODS[m].label}</option>)}
            </select>
            <B onClick={() => act({ type: "mood", mood })}>Set</B>
          </Row>

          <Label>Emote</Label>
          <Row>{EMOTES.map((e) => <B key={e} onClick={() => act({ type: "emote", emote: e })}>{e}</B>)}</Row>

          <Label>Say</Label>
          <Row>
            <input value={text} onChange={(e) => setText(e.target.value)} style={{ ...S.input, flex: 1 }} />
            <B onClick={() => text.trim() && act({ type: "say", text: text.trim() })}>Say</B>
          </Row>

          <Label>Spotlight (tutorial)</Label>
          <Row>
            <B on={pick === "spot"} onClick={() => setPick("spot")}>Spotlight…</B>
            <B on={shape === "rect"} onClick={() => setShape("rect")}>▭ box</B>
            <B on={shape === "ellipse"} onClick={() => setShape("ellipse")}>◯ ellipse</B>
          </Row>
          <Row>
            <label style={S.check}><input type="checkbox" checked={spotClick} onChange={(e) => setSpotClick(e.target.checked)} /> wait for click</label>
            <B onClick={() => act({ type: "spotlight", area: null })}>Clear spotlight</B>
          </Row>
          <div style={{ fontSize: 10, color: "#5d7f90", marginTop: -2, marginBottom: 4 }}>Uses the Say text as the caption.</div>

          <Label>Task (hands-on: viewer must do it)</Label>
          <Row>
            <B on={pick === "taskel"} onClick={() => setPick("taskel")}>Task on element…</B>
            <B on={pick === "task"} onClick={() => setPick("task")}>Task on area…</B>
          </Row>
          <Row>
            <span style={{ fontSize: 11, color: "#7fa2b2" }}>Area task:</span>
            <B on={taskAction === "click"} onClick={() => setTaskAction("click")}>click</B>
            <B on={taskAction === "type"} onClick={() => setTaskAction("type")}>type</B>
          </Row>
          <Row>
            <input value={expect} onChange={(e) => setExpect(e.target.value)} placeholder="text they must type (empty = anything + Enter)" style={{ ...S.input, flex: 1 }} />
          </Row>
          <div style={{ fontSize: 10, color: "#5d7f90", marginTop: -2, marginBottom: 4 }}>
            Element: click a real button (click task) or field (type task). Area: drag any box, e.g. part of the map. The Say text is what he says; shape uses ▭ / ◯ above. Viewers can always skip.
          </div>

          <Label>Resize him (adds a Size step)</Label>
          <Slider label="New size (of screen's short side)" value={sizeTo} min={0.05} max={0.3} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} set={setSizeTo} />
          <Row>
            <input type="number" min={0} step={0.1} value={sizeSecs} onChange={(e) => setSizeSecs(Math.max(0, +e.target.value))} style={{ ...S.input, width: 56 }} />
            <span style={{ fontSize: 11, color: "#7fa2b2" }}>sec</span>
            <select value={sizeEase} onChange={(e) => setSizeEase(e.target.value as Ease)} style={S.input}>
              {EASES.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <B onClick={() => act({ type: "size", size: sizeTo, seconds: sizeSecs, ease: sizeEase })}>Resize ›</B>
          </Row>
          <div style={{ fontSize: 10, color: "#5d7f90", marginTop: -2, marginBottom: 4 }}>
            He tweens from his current size to the new one over the seconds you set, with that easing (back = slight overshoot). Edit any Size step in the list below.
          </div>

          <Label>Wait</Label>
          <Row>
            <input type="number" min={0.1} step={0.1} value={wait} onChange={(e) => setWait(+e.target.value)} style={{ ...S.input, width: 64 }} />
            <span style={{ fontSize: 11, color: "#7fa2b2" }}>sec</span>
            <B onClick={() => setScript((s) => ({ ...s, steps: [...s.steps, { type: "wait", seconds: wait }] }))}>Add wait</B>
          </Row>

          <Label>Script · {script.steps.length} steps</Label>
          <div style={S.list}>
            {script.steps.length === 0 && <div style={{ color: "#5d7f90", padding: 6 }}>Press Record, then do things.</div>}
            {script.steps.map((s, i) => (
              <div key={i} style={{ ...S.step, ...(playing === i ? S.stepOn : {}) }}>
                <span style={{ ...S.idx, color: cursor === i && playing === -1 && i > 0 ? "#37e3ff" : S.idx.color }}>{cursor === i && i > 0 && playing === -1 ? "›" : i + 1}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {s.type === "wait" ? (
                    <>Wait <input type="number" step={0.1} min={0} value={s.seconds} onChange={(e) => edit(i, { seconds: +e.target.value })} style={{ ...S.input, width: 52, padding: "1px 3px" }} />s</>
                  ) : s.type === "say" ? (
                    <>Say <input value={s.text} onChange={(e) => edit(i, { text: e.target.value })} style={{ ...S.input, width: "70%", padding: "1px 3px" }} /></>
                  ) : s.type === "spotlight" && s.area ? (
                    <>
                      {s.shape === "ellipse" ? "◯" : "▭"} Spot{" "}
                      <input value={s.text ?? ""} placeholder="caption" onChange={(e) => edit(i, { text: e.target.value || undefined })} style={{ ...S.input, width: "52%", padding: "1px 3px" }} />{" "}
                      <label title="Wait for the viewer to click"><input type="checkbox" checked={s.click !== false} onChange={(e) => edit(i, { click: e.target.checked ? undefined : false })} /> click</label>
                    </>
                  ) : s.type === "task" ? (
                    <>
                      {s.action === "type" ? "⌨" : "☝"} Task{" "}
                      <select value={s.action} onChange={(e) => edit(i, { action: e.target.value as TaskAction })} style={{ ...S.input, padding: "1px 2px" }}>
                        <option value="click">click</option>
                        <option value="type">type</option>
                      </select>{" "}
                      {s.action === "type" && (
                        <input value={s.expect ?? ""} placeholder="any" title="Text they must type (empty = anything + Enter)" onChange={(e) => edit(i, { expect: e.target.value || undefined })} style={{ ...S.input, width: "24%", padding: "1px 3px" }} />
                      )}{" "}
                      <input value={s.text ?? ""} placeholder="what he says" onChange={(e) => edit(i, { text: e.target.value || undefined })} style={{ ...S.input, width: s.action === "type" ? "30%" : "50%", padding: "1px 3px" }} />
                    </>
                  ) : s.type === "size" ? (
                    <>
                      Size <input type="number" min={5} max={30} step={0.5} value={Math.round(s.size * 1000) / 10} onChange={(e) => edit(i, { size: +e.target.value / 100 })} style={{ ...S.input, width: 46, padding: "1px 3px" }} />%{" "}
                      <input type="number" min={0} step={0.1} value={s.seconds ?? 0.6} onChange={(e) => edit(i, { seconds: Math.max(0, +e.target.value) })} style={{ ...S.input, width: 42, padding: "1px 3px" }} />s{" "}
                      <select value={s.ease ?? "easeInOut"} onChange={(e) => edit(i, { ease: e.target.value as Ease })} style={{ ...S.input, padding: "1px 2px" }}>
                        {EASES.map((e) => <option key={e} value={e}>{e}</option>)}
                      </select>
                    </>
                  ) : s.type === "fly" ? (
                    <>{describeStep({ ...s, pass: false })} <label title="Fly through without stopping"><input type="checkbox" checked={!!s.pass} onChange={(e) => edit(i, { pass: e.target.checked || undefined })} /> thru</label></>
                  ) : (
                    describeStep(s)
                  )}
                </span>
                <button style={S.mini} title="Play from here" onClick={() => play(i)}>▶</button>
                <button style={S.mini} onClick={() => move(i, -1)}>↑</button>
                <button style={S.mini} onClick={() => move(i, 1)}>↓</button>
                <button style={S.mini} onClick={() => remove(i)}>✕</button>
              </div>
            ))}
          </div>

          <Row>
            <B onClick={() => { setScript(smoothScript(script)); flash("Smoothed: waits tidied, paths joined"); }}>Smooth</B>
            {playing >= 0 && !stepBusy && run.current ? <B on onClick={stopAll}>■ Stop</B> : <B onClick={() => play(0)}>▶ Play</B>}
            <B onClick={stepOnce}>{stepBusy ? "…" : `Step › ${Math.min(cursor, script.steps.length - 1) + 1 || ""}`}</B>
            <B onClick={stopAll}>Reset</B>
            <B onClick={() => { stopAll(); setScript((s) => ({ ...s, steps: [] })); }}>Clear</B>
          </Row>
          <Row>
            <B onClick={copy}>Copy JSON</B>
            <B on={importing} onClick={() => setImporting((v) => !v)}>Import…</B>
          </Row>
          {importing && (
            <div>
              <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste a script JSON" rows={4} style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
              <B onClick={doImport}>Load</B>
            </div>
          )}

          <Label>Script defaults (resolution-agnostic)</Label>
          <Slider label="Starting size (of screen's short side)" value={script.size} min={0.05} max={0.25} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`}
            set={(v) => { setScript((s) => ({ ...s, size: v })); stage.setSize(v); }} />
          <Slider label="Speed (screen diagonals / s)" value={script.speed} min={0.1} max={1.5} step={0.05} fmt={(v) => v.toFixed(2)}
            set={(v) => setScript((s) => ({ ...s, speed: v }))} />
          <div style={{ fontSize: 10, color: "#5d7f90", marginTop: 6, lineHeight: 1.4 }}>
            Points snap to the element you click (add <code>data-tour="name"</code> to UI for rock-solid anchors) with a screen-% fallback.
            ~{Math.round(script.steps.reduce((t, s) => t + (s.type === "wait" ? s.seconds : s.type === "say" ? s.seconds ?? sayDuration(s.text) : 0), 0))}s of waits/speech.
          </div>
        </div>
      )}

      {toast && <div data-firefly-ui style={S.toast}>{toast}</div>}
    </>
  );
}

// ---------------------------------------------------------------- draggable panel
/**
 * Drag-by-handle positioning, remembered in localStorage and always kept on screen
 * (re-clamped when the window resizes or the panel changes size).
 */
function useDraggable(key: string, initial: { x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? initial; } catch { return initial; }
  });
  const [dragging, setDragging] = useState(false);
  const clamp = (p: { x: number; y: number }) => {
    const r = ref.current?.getBoundingClientRect();
    const w = r?.width ?? 330, h = Math.min(r?.height ?? 200, innerHeight - 12);
    return { x: Math.min(Math.max(6, p.x), innerWidth - w - 6), y: Math.min(Math.max(6, p.y), innerHeight - h - 6) };
  };
  useEffect(() => {
    const fix = () => setPos((p: { x: number; y: number }) => clamp(p));
    fix();
    addEventListener("resize", fix);
    const ro = ref.current ? new ResizeObserver(fix) : null;
    if (ref.current) ro!.observe(ref.current);
    return () => { removeEventListener("resize", fix); ro?.disconnect(); };
  }, [ref.current]); // eslint-disable-line react-hooks/exhaustive-deps
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => setPos(clamp({ x: start.x + ev.clientX - start.mx, y: start.y + ev.clientY - start.my }));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setDragging(false);
      setPos((p: { x: number; y: number }) => { try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* ignore */ } return p; });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return { ref, pos: pos as { x: number; y: number }, dragging, onPointerDown };
}

// ---------------------------------------------------------------- tiny UI
function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginBottom: 6 }}>{children}</div>;
}
function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "#5d7f90", margin: "8px 0 4px" }}>{children}</div>;
}
function B({ children, onClick, on }: { children: ReactNode; onClick: () => void; on?: boolean }) {
  return <button onClick={onClick} style={{ ...S.btn, ...(on ? S.btnOn : {}) }}>{children}</button>;
}
function Slider({ label, value, min, max, step, set, fmt }: { label: string; value: number; min: number; max: number; step: number; set: (v: number) => void; fmt: (v: number) => string }) {
  return (
    <label style={{ display: "block", fontSize: 10.5, color: "#9fb6c2", margin: "4px 0" }}>
      <span style={{ display: "flex", justifyContent: "space-between" }}><span>{label}</span><span>{fmt(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)} style={{ width: "100%" }} />
    </label>
  );
}

const S: Record<string, CSSProperties> = {
  launcher: { position: "fixed", left: 12, bottom: 12, pointerEvents: "auto", padding: "6px 9px", fontSize: 11, fontWeight: 700, letterSpacing: ".1em", fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#37e3ff", background: "rgba(4,18,28,.92)", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(55,227,255,.5)", borderRadius: 6, cursor: "pointer" },
  rec: { color: "#ff5a4a", borderColor: "#ff5a4a" },
  panel: { position: "fixed", width: 330, maxHeight: "calc(100vh - 24px)", overflowY: "auto", pointerEvents: "auto", padding: 12, color: "#dff6ff", font: "12px/1.35 'JetBrains Mono', ui-monospace, monospace", background: "rgba(3,14,22,.96)", border: "1px solid rgba(55,227,255,.35)", borderRadius: 8, boxShadow: "0 12px 40px rgba(0,0,0,.5)" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 12 },
  x: { background: "none", border: "none", color: "#7fa2b2", cursor: "pointer", fontSize: 13 },
  check: { display: "flex", gap: 4, alignItems: "center", fontSize: 11, color: "#9fb6c2" },
  btn: { padding: "4px 7px", fontSize: 11, fontFamily: "inherit", background: "transparent", color: "#bfe9f5", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(55,227,255,.28)", borderRadius: 4, cursor: "pointer", textTransform: "capitalize" },
  btnOn: { borderColor: "#37e3ff", color: "#37e3ff", boxShadow: "0 0 8px -3px #37e3ff" },
  input: { background: "#061724", color: "#dff6ff", border: "1px solid rgba(55,227,255,.28)", borderRadius: 4, fontFamily: "inherit", fontSize: 11, padding: "4px 6px" },
  list: { maxHeight: 220, overflowY: "auto", border: "1px solid rgba(55,227,255,.15)", borderRadius: 4, marginBottom: 6 },
  step: { display: "flex", alignItems: "center", gap: 4, padding: "3px 5px", fontSize: 11, borderBottom: "1px solid rgba(55,227,255,.08)" },
  stepOn: { background: "rgba(55,227,255,.12)" },
  idx: { width: 18, color: "#5d7f90", textAlign: "right", flexShrink: 0 },
  mini: { background: "none", border: "none", color: "#7fa2b2", cursor: "pointer", padding: "0 2px", fontSize: 11 },
  // While picking a point / area the panel gets out of the way (it may cover the target).
  panelPicking: { opacity: 0, pointerEvents: "none" },
  pickLayer: { position: "fixed", inset: 0, pointerEvents: "auto", cursor: "crosshair", background: "rgba(55,227,255,.04)" },
  pickHint: { position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", padding: "6px 12px", fontSize: 12, color: "#04121c", background: "#37e3ff", borderRadius: 6, fontFamily: "'JetBrains Mono', monospace" },
  toast: { position: "fixed", left: 12, bottom: 50, transform: "translateY(-100%)", marginBottom: 8, padding: "6px 10px", fontSize: 11, color: "#04121c", background: "#37e3ff", borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", pointerEvents: "none" },
};
