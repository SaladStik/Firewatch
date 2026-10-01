/**
 * Firefly playground — /firefly.html. Not part of the map; just for judging
 * the mascot's look and animation before committing to him.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import {
  DEFAULT_POSE, Firefly, FireflyAgent, makeConfig, MOOD_NAMES, MOODS, SKINS, useFirefly,
  type EmoteName, type FireflyPose, type MoodName,
} from "../firefly";

const EMOTES: EmoteName[] = ["hop", "spin", "shake", "nod", "flutter"];
const LINES = [
  "Hey! I'm Ember — I keep an eye on Alberta's forests.",
  "New hotspot near Swan Hills. Want me to take you there?",
  "Fire weather is extreme in the north today. Stay sharp!",
  "All quiet out there. Good day for a patrol.",
];

function App() {
  const stage = useRef<HTMLDivElement>(null);
  const ctl = useFirefly({ x: 420, y: 320, mood: "happy" });
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const [skin, setSkin] = useState("classic");
  const [size, setSize] = useState(150);
  const [wingScale, setWingScale] = useState(1);
  const [follow, setFollow] = useState(false);
  const [watch, setWatch] = useState(true);
  const [wander, setWander] = useState(false);
  const [manual, setManual] = useState(false);
  const [text, setText] = useState(LINES[0]);

  const config = useMemo(() => {
    const base = makeConfig({ palette: SKINS[skin] });
    return {
      ...base,
      wingUpper: { ...base.wingUpper, length: base.wingUpper.length * wingScale, width: base.wingUpper.width * wingScale },
      wingLower: { ...base.wingLower, length: base.wingLower.length * wingScale, width: base.wingLower.width * wingScale },
    };
  }, [skin, wingScale]);

  // Keep wander bounds = the stage.
  useEffect(() => {
    const r = stage.current!.getBoundingClientRect();
    ctl.bounds = { x0: 90, y0: 110, x1: r.width - 90, y1: r.height - 90 };
  }, [ctl]);

  useEffect(() => { ctl.wander = wander; }, [ctl, wander]);
  useEffect(() => { ctl.manual = manual; }, [ctl, manual]);
  useEffect(() => { ctl.follow(follow ? () => mouse.current && { x: mouse.current.x + 70, y: mouse.current.y - 60 } : null); }, [ctl, follow]);
  useEffect(() => { ctl.lookAt(watch ? mouse.current : null); }, [ctl, watch]);

  const onMove = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (watch) ctl.lookAt(mouse.current);
  };
  const onClick = (e: React.MouseEvent) => {
    if (follow) return;
    const r = stage.current!.getBoundingClientRect();
    void ctl.flyTo(e.clientX - r.left, e.clientY - r.top).then(() => ctl.play("hop"));
  };

  return (
    <div style={S.page}>
      <div ref={stage} style={S.stage} onPointerMove={onMove} onClick={onClick}>
        <div style={S.hint}>click anywhere to fly · he watches your cursor</div>
        <FireflyAgent controller={ctl} config={config} size={size} />
      </div>

      <aside style={S.panel}>
        <h1 style={S.h1}>FIREFLY <span style={{ color: "#37e3ff" }}>//</span> MASCOT</h1>

        <Section title="Mood">
          <Grid>
            {MOOD_NAMES.map((m) => (
              <Btn key={m} on={ctl.mood === m} onClick={() => ctl.setMood(m)}>{MOODS[m].label}</Btn>
            ))}
          </Grid>
        </Section>

        <Section title="Emotes">
          <Grid>{EMOTES.map((e) => <Btn key={e} onClick={() => ctl.play(e)}>{e}</Btn>)}</Grid>
        </Section>

        <Section title="Behaviour">
          <Check on={watch} set={setWatch}>Eyes follow cursor</Check>
          <Check on={follow} set={setFollow}>Follow cursor</Check>
          <Check on={wander} set={setWander}>Wander around</Check>
          <Btn onClick={() => tour(ctl, stage.current!)}>Fly a tour</Btn>
        </Section>

        <Section title="Say">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} style={S.input} />
          <Grid>
            <Btn onClick={() => ctl.say(text)}>Say it</Btn>
            <Btn onClick={() => { const l = LINES[Math.floor(Math.random() * LINES.length)]; setText(l); ctl.say(l); }}>Random line</Btn>
          </Grid>
        </Section>

        <Section title="Look">
          <Grid>{Object.keys(SKINS).map((s) => <Btn key={s} on={skin === s} onClick={() => setSkin(s)}>{s}</Btn>)}</Grid>
          <Slider label="Size" min={60} max={260} step={1} value={size} set={setSize} />
          <Slider label="Wing size" min={0.6} max={1.5} step={0.01} value={wingScale} set={setWingScale} />
        </Section>

        <Section title="Manual pose (every part independent)">
          <Check on={manual} set={setManual}>Drive pose by hand</Check>
          {manual && <ManualPose pose={ctl.pose} />}
        </Section>
      </aside>

      <footer style={S.gallery}>
        {MOOD_NAMES.map((m) => <MoodTile key={m} mood={m} config={config} />)}
      </footer>
    </div>
  );
}

/** Each tile runs its own controller — proof the mascot can be instanced. */
function MoodTile({ mood, config }: { mood: MoodName; config: ReturnType<typeof makeConfig> }) {
  const ctl = useFirefly({ x: 0, y: 0, mood });
  return (
    <div style={S.tile}>
      <Firefly pose={ctl.pose} config={config} size={78} />
      <div style={S.tileLabel}>{MOODS[mood].label}</div>
    </div>
  );
}

function ManualPose({ pose }: { pose: FireflyPose }) {
  const [, force] = useState(0);
  const num = (label: string, get: () => number, set: (v: number) => void, min: number, max: number) => (
    <Slider key={label} label={label} min={min} max={max} step={0.01} value={get()} set={(v) => { set(v); force((f) => f + 1); }} />
  );
  return (
    <div>
      {num("Upper wing L lift", () => pose.wings.upperL.lift, (v) => (pose.wings.upperL.lift = v), -50, 50)}
      {num("Upper wing R lift", () => pose.wings.upperR.lift, (v) => (pose.wings.upperR.lift = v), -50, 50)}
      {num("Lower wing L lift", () => pose.wings.lowerL.lift, (v) => (pose.wings.lowerL.lift = v), -50, 50)}
      {num("Lower wing R lift", () => pose.wings.lowerR.lift, (v) => (pose.wings.lowerR.lift = v), -50, 50)}
      {num("Wing open (all)", () => pose.wings.upperL.open, (v) => { for (const w of Object.values(pose.wings)) w.open = v; }, 0, 1)}
      {num("Antenna L", () => pose.antennaL, (v) => (pose.antennaL = v), -40, 40)}
      {num("Antenna R", () => pose.antennaR, (v) => (pose.antennaR = v), -40, 40)}
      {num("Eye L open", () => pose.eyeOpenL, (v) => (pose.eyeOpenL = v), 0, 1)}
      {num("Eye R open", () => pose.eyeOpenR, (v) => (pose.eyeOpenR = v), 0, 1)}
      {num("Look X", () => pose.lookX, (v) => (pose.lookX = v), -1, 1)}
      {num("Look Y", () => pose.lookY, (v) => (pose.lookY = v), -1, 1)}
      {num("Smile", () => pose.smile, (v) => (pose.smile = v), -1, 1)}
      {num("Mouth open", () => pose.mouthOpen, (v) => (pose.mouthOpen = v), 0, 1)}
      {num("Brow slant", () => pose.brow, (v) => { pose.brow = v; pose.browAmount = 1; }, -1, 1)}
      {num("Blush", () => pose.blush, (v) => (pose.blush = v), 0, 1)}
      {num("Lantern", () => pose.lantern, (v) => (pose.lantern = v), 0, 1.5)}
      {num("Fire alarm", () => pose.alarm, (v) => (pose.alarm = v), 0, 1)}
      {num("Tilt", () => pose.rotation, (v) => (pose.rotation = v), -45, 45)}
      {num("Squash", () => pose.squash, (v) => (pose.squash = v), -0.3, 0.3)}
      <Btn onClick={() => { Object.assign(pose, { ...DEFAULT_POSE, x: pose.x, y: pose.y, wings: structuredClone(DEFAULT_POSE.wings) }); force((f) => f + 1); }}>Reset pose</Btn>
    </div>
  );
}

async function tour(ctl: ReturnType<typeof useFirefly>, stage: HTMLDivElement) {
  const r = stage.getBoundingClientRect();
  const pts: [number, number][] = [[0.2, 0.3], [0.75, 0.25], [0.8, 0.7], [0.3, 0.75], [0.5, 0.5]];
  ctl.setMood("excited");
  for (const [fx, fy] of pts) await ctl.flyTo(r.width * fx, r.height * fy, { speed: 560 });
  ctl.play("spin");
  ctl.setMood("happy");
  ctl.say("Tour complete!");
}

// ---------------------------------------------------------------- tiny UI kit
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ marginBottom: 16 }}><div style={S.label}>{title}</div>{children}</section>;
}
function Grid({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>{children}</div>;
}
function Btn({ children, onClick, on }: { children: ReactNode; onClick: () => void; on?: boolean }) {
  return <button onClick={onClick} style={{ ...S.btn, ...(on ? S.btnOn : {}) }}>{children}</button>;
}
function Check({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: ReactNode }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, margin: "4px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> {children}
    </label>
  );
}
function Slider({ label, min, max, step, value, set }: { label: string; min: number; max: number; step: number; value: number; set: (v: number) => void }) {
  return (
    <label style={{ display: "block", fontSize: 11, margin: "6px 0", color: "#9fb6c2" }}>
      <span style={{ display: "flex", justifyContent: "space-between" }}><span>{label}</span><span>{value.toFixed(2)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)} style={{ width: "100%" }} />
    </label>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { position: "fixed", inset: 0, display: "grid", gridTemplateColumns: "1fr 300px", gridTemplateRows: "1fr 120px", background: "#04121c", color: "#dff6ff", fontFamily: "'JetBrains Mono', monospace" },
  stage: {
    position: "relative", overflow: "hidden", cursor: "crosshair",
    backgroundColor: "#06192a",
    backgroundImage: "linear-gradient(rgba(55,227,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(55,227,255,.05) 1px, transparent 1px)",
    backgroundSize: "56px 56px",
  },
  hint: { position: "absolute", top: 14, left: 16, fontSize: 11, letterSpacing: ".12em", color: "#5d7f90", textTransform: "uppercase" },
  panel: { gridRow: "1 / span 2", gridColumn: 2, overflowY: "auto", padding: 16, borderLeft: "1px solid rgba(55,227,255,.18)", background: "#03101a" },
  h1: { fontSize: 14, letterSpacing: ".22em", margin: "0 0 16px" },
  label: { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#5d7f90", marginBottom: 6 },
  btn: { padding: "6px 4px", fontSize: 11, background: "transparent", color: "#bfe9f5", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(55,227,255,.25)", cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize" },
  btnOn: { borderColor: "#37e3ff", color: "#37e3ff", boxShadow: "0 0 10px -3px #37e3ff" },
  input: { width: "100%", boxSizing: "border-box", background: "#061724", color: "#dff6ff", border: "1px solid rgba(55,227,255,.25)", fontFamily: "inherit", fontSize: 11, padding: 6, marginBottom: 4, resize: "vertical" },
  gallery: { gridColumn: 1, display: "flex", gap: 6, alignItems: "center", justifyContent: "center", borderTop: "1px solid rgba(55,227,255,.18)", background: "#03101a" },
  tile: { display: "flex", flexDirection: "column", alignItems: "center", width: 96 },
  tileLabel: { fontSize: 10, color: "#7fa2b2", marginTop: -6 },
};

createRoot(document.getElementById("root")!).render(<App />);
