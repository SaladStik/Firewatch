# Firefly scripts: recorder, player, tutorials

Record the firefly doing things on **any page** of the site: flying around, emoting, talking, waiting, and spotlighting parts of the UI. Copy the result as JSON and replay it later as a tour, tutorial or cameo.

Scripts are **resolution-agnostic**: a script recorded on a 4K monitor plays the same, relatively, on a 720p laptop.

> See also: [the mascot itself](../README.md) (look, pose, moods, controller).

---

## Quick start

1. Run the site in dev (`npm run dev`), or add `?fireflydev` to any URL in a deployed build. It's remembered in `localStorage`.
2. Press **Ctrl+Shift+F**, or click the **FF** button bottom-left, to open the recorder panel. Drag the panel by its header to put it anywhere.
3. Press **● Record** and do things (see the panel below). The firefly performs each action live as you record it.
4. Press **■ Stop recording**, then **Smooth** (optional) and **▶ Play** to watch it back.
5. Press **Copy JSON** and paste it into the codebase:

```ts
// src/tours/welcome.ts
import type { FireflyScript } from "../mascot/firefly/script";
export const WELCOME_TOUR: FireflyScript = { /* pasted JSON */ };
```

```ts
import { playScript } from "../mascot/firefly/script";
import { WELCOME_TOUR } from "../tours/welcome";

const run = playScript(WELCOME_TOUR); // mounts the overlay if needed, plays, hides him at the end
await run.done;                       // or run.stop() to cancel
```

`playScript` works in production builds. Only the recorder panel is limited to dev or `?fireflydev`.

---

## The recorder panel

| Section | Controls |
|---|---|
| **Record** | **● Record** / **■ Stop recording**. **Capture pauses**: idle gaps between your actions (> 0.3 s) are recorded as `wait` steps. |
| **Move** | **Fly to…** (click a point), **Look at…** (click), **Look ahead**, **Show at…** (click), **Hide**, **Start point…** (where he appears when the script starts) |
| **Mood** | Pick a mood and press **Set**. |
| **Emote** | hop · spin · shake · nod · flutter |
| **Say** | Type a line and press **Say**. The text is also the caption for spotlights. |
| **Spotlight** | **Spotlight…** (drag a box), **▭ box** / **◯ ellipse**, **wait for click**, **Clear spotlight** |
| **Wait** | Add a fixed wait (seconds). |
| **Script list** | Every step, in order. Edit wait seconds, say text, spotlight captions, the fly "thru" flag and the spotlight "click" flag inline. **▶** = play from this step. **↑ ↓** reorder, **✕** delete. |
| **Run-through** | **▶ Play** (whole script), **Step ›** (run one step at a time; the cursor shows which step is next), **Reset**, **Smooth**, **Clear** |
| **Share** | **Copy JSON**, **Import…** (paste a script and **Load**) |
| **Playback scale** | **Size** (fraction of the screen's short side) and **Speed** (screen diagonals per second) |

**Notes:**
- When you pick a point or drag a spotlight, the panel fades out of the way, so you can reach anything underneath it. Press **Esc** to cancel a pick.
- The working script is saved in `localStorage`, so a page reload doesn't lose it.
- The panel's position is remembered too, and it's always kept on screen.

### Seeing how a script runs

- **▶ Play** runs everything from the start. The step currently running is highlighted in the list.
- **▶ on a row** plays *from that step*. He's placed where he would be at that point (position, mood, visibility) without replaying the earlier steps.
- **Step ›** runs exactly one step per press: fly, then talk, then spotlight (click through), and so on. Use it to check timing and placement.

---

## Spotlights (tutorial highlights)

A spotlight step:
1. **dims the whole screen** except the chosen area (a box or ellipse), and outlines the area with a soft glowing edge;
2. **flies the firefly beside the area**, on the side with the most free room, so he doesn't cover it;
3. **turns him so his lantern (tail light) points at it**, with a beam of light from the lantern to the area;
4. shows the **caption** in his speech bubble (kept up while waiting);
5. **waits for the viewer to click through**: a click anywhere, or Enter / Space / →. A "Click to continue ›" chip shows under the area.

```ts
{ type: "spotlight", area: { selector: '[data-tour="layers"]', vx0: 0.01, vy0: 0.23, vx1: 0.13, vy1: 0.43 },
  shape: "rect", text: "These toggle the map layers." }
```

- `click: false` keeps the spotlight up without waiting. Clear it later with `{ type: "spotlight", area: null }`.
- The highlight follows its element live: if the layout reflows or the window resizes mid-step, the cut-out moves with it.

---

## How resolution independence works

No pixel values are ever stored.

| What | Stored as |
|---|---|
| **Points** (`Anchor`) | The **element** under the click (a CSS selector) plus **where inside it** (`ex, ey`, 0…1 of its box), and a **viewport fraction** fallback (`vx, vy`, 0…1). |
| **Areas** (`Area`) | The smallest **element that contains the dragged box** plus the box **as fractions of that element** (`ex0…ey1`, can be slightly outside 0…1 for padding), and a viewport-fraction fallback (`vx0…vy1`). |
| **Flight speed** | **Screen diagonals per second**, so the same trip takes the same time at any resolution. |
| **Mascot size** | **Fraction of the screen's short side**. |
| **Pass-through radius** | 3% of the screen diagonal. |

At playback, an anchor resolves against the element's **current** box (`getBoundingClientRect`). If the element can't be found, it falls back to the viewport fraction. In testing, a spotlight on the Layers panel recorded at 1920×1080, where the panel sat about 250 px down, landed exactly on the panel at 1280×720, where it sits about 90 px down.

### Making anchors robust: `data-tour`

The recorder picks selectors in this order:
1. `[data-tour="…"]`
2. `#id`
3. a short `tag:nth-of-type` path (used only if it's unique)

Paths can break when the DOM changes, so **tag the UI you'll tour**:

```tsx
<Panel title="Layers" tour="layers">…</Panel>   // Panel forwards it as data-tour
<div data-tour="fire-feed">…</div>
```

Already tagged:
- **Map:** `brand`, `lod`, `layers`, `legend`, `explore`, `sector`, `fire-feed`, `nav`.
- **Preview page:** every panel section (`mood`, `emotes`, `colours`, …).

Elements larger than ~45% of the screen (e.g. the map canvas) are treated as background, so clicks on them use the viewport fallback. That's what you want for "fly to the middle of the map".

---

## Script format

```ts
interface FireflyScript {
  version: 1;
  name?: string;
  size: number;    // fraction of min(viewport w, h), e.g. 0.11
  speed: number;   // viewport diagonals per second, e.g. 0.45
  start: Anchor;   // where he appears
  steps: ScriptStep[];
}
```

| Step | Fields | Waits for |
|---|---|---|
| `fly` | `to: Anchor`, `speed?`, `pass?` (fly through without stopping) | arrival (or the pass radius) |
| `look` | `at: Anchor \| null` | — |
| `mood` | `mood: MoodName` | — |
| `emote` | `emote: "hop" \| "spin" \| "shake" \| "nod" \| "flutter"` | the emote's duration |
| `say` | `text`, `seconds?` (default scales with length) | `seconds` |
| `wait` | `seconds` | `seconds` |
| `show` | `at?: Anchor` | — |
| `hide` | — | — |
| `spotlight` | `area: Area \| null`, `shape?: "rect" \| "ellipse"`, `text?`, `click?` (default true) | the viewer's click (if `click`) |

Scripts are plain JSON, so you can hand-write or edit them. See `DEMO_TOUR` in `src/mascot/preview/main.tsx` for a hand-written example.

### Smooth

**Smooth** tidies a raw recording:
- merges consecutive waits, rounds them to 0.1 s, and drops tiny ones (< 0.15 s);
- keeps only the last of back-to-back mood changes or look targets;
- turns a fly that's immediately followed by another fly into a **pass-through** waypoint, so a chain of clicks becomes one smooth flight path instead of stop-start hops.

---

## API

```ts
import {
  playScript, getStage, runScript, execStep, prepareAt, smoothScript, describeStep,
  anchorAt, areaFromBox, resolveAnchor, resolveArea, mountFireflyDev, isFireflyDevEnabled,
  type FireflyScript, type ScriptStep, type Anchor, type Area,
} from "./mascot/firefly/script";
```

| Function | Description |
|---|---|
| `playScript(script, { hideAtEnd?, onStep? })` | Play on the shared stage. Returns `{ done, stop }`. Hides him at the end by default. |
| `getStage()` | The shared overlay (created on first use). Has `controller`, `setVisible`, `setSize`, `setConfig`, `setSpotlight`, `play(script, { from })`, `stop()`. |
| `runScript(ctl, script, hooks, from?)` | Run on any `FireflyController` (e.g. your own instance). |
| `execStep(ctl, step, { speed }, hooks)` | Run a single step. |
| `prepareAt(ctl, script, i, hooks)` | Put him in the state he'd be in just before step `i`. |
| `smoothScript(script)` | Returns a tidied copy. |
| `anchorAt(x, y)` / `areaFromBox(x0, y0, x1, y1)` | Build resolution-agnostic anchors and areas from screen coordinates. |
| `resolveAnchor(a)` / `resolveArea(a)` | Back to screen coordinates, right now. |
| `mountFireflyDev()` | Mount the recorder on a page. A no-op unless dev or `?fireflydev`. Already called in `src/main.tsx` and the preview page. |

To turn the recorder off again in a deployed build, run `localStorage.removeItem("firefly.dev")`.

---

## Files

```
script/
  types.ts        FireflyScript, ScriptStep, Anchor, Area
  anchors.ts      element/viewport anchoring, selector generation, area fitting
  player.ts       execStep, runScript, prepareAt, smoothScript, spotlight placement
  stage.tsx       shared overlay: mascot, spotlight (dim + beam + click-through), playScript
  DevOverlay.tsx  the recorder panel (draggable), mountFireflyDev
  index.ts        exports
```

The stage and recorder render into their own fixed layers at the very top of the page. They're marked `data-firefly-ui`, so they never become anchor targets themselves. The stage is click-through except while a spotlight waits for a click.
