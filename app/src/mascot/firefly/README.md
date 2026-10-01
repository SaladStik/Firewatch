# Firefly mascot

A 2D mascot (and future AI agent) for EMBER//GRID: a glowing firefly drawn entirely in SVG and written in TypeScript and React. There are no image assets.

He's built so that every part of him can be animated on its own. He can fly around the screen, emote, talk and change outfits mid-spin.

> **Status: preview.** He isn't used in the map yet. Try him at **`/firefly.html`** (`npm run dev`, then open http://localhost:5173/firefly.html).

---

## Quick start

```tsx
import { FireflyAgent, useFirefly } from "./mascot/firefly";

function Page() {
  const ctl = useFirefly({ x: 300, y: 200, mood: "happy" }); // creates + runs the controller
  return (
    <div style={{ position: "relative", height: "100vh" }}>
      <FireflyAgent controller={ctl} size={120} />
      <button onClick={async () => {
        ctl.setMood("alert");
        await ctl.flyTo(640, 300);
        ctl.play("hop");
        ctl.say("New hotspot near Swan Hills!");
      }}>Go</button>
    </div>
  );
}
```

`<FireflyAgent/>` is absolutely positioned at the controller's `pose.x / pose.y` in pixels. Put it inside a `position: relative` container that matches the area he flies in.

---

## How it's built

```
mascot/firefly/
  types.ts         FireflyConfig (how he looks) + FireflyPose (what he's doing)
  config.ts        DEFAULT_CONFIG, DEFAULT_POSE, palettes (SKINS), makeConfig()
  moods.ts         MOODS: personality presets as data
  Firefly.tsx      <Firefly/>: pure SVG renderer (pose + config → drawing)
  controller.ts    FireflyController: the "brain" (procedural animation, flight, emotes, speech)
  FireflyAgent.tsx useFirefly() hook + <FireflyAgent/> (positioned on screen, speech bubble)
  index.ts         public exports
mascot/preview/    the /firefly.html playground
```

The design rule is that **the renderer has no logic**. `<Firefly/>` draws exactly the pose it's given, with no timers or internal state. That means anything can animate him: the built-in controller, GSAP, Motion, `requestAnimationFrame`, sliders, or a recorded timeline.

```
           ┌────────────── you can drive any of these ──────────────┐
  moods ──▶ FireflyController ──▶ FireflyPose ──▶ <Firefly/> ──▶ SVG
                    ▲                  ▲
           flyTo / say / spin    manual / override / GSAP
```

---

## Config: how he looks

`FireflyConfig` (in `types.ts`). Build one with `makeConfig(patch)`, which merges onto `DEFAULT_CONFIG`.

| Field | Meaning |
|---|---|
| `palette` | All colours (table below). Use a preset from `SKINS` or your own. |
| `bodyRadius` | Body size in SVG units (default 34). Every other size is relative to it. |
| `wingUpper`, `wingLower` | `{ length, width, angle, hinge }`. Length and width are in body radii. `angle` is the resting angle in degrees (negative = up). `hinge` is the attach point `[x, y]` in body radii, for the right side (mirrored on the left). |
| `antennaLength`, `antennaSpread` | Length in body radii; resting spread from vertical in degrees. |
| `eyeSize`, `eyeSpacing`, `eyeY` | Eye radius, half-distance between eyes, vertical offset, all in body radii. |
| `lanternSize` | Radius of the glowing abdomen, in body radii. |
| `glow` | Blur radius of the soft glow. `0` turns it off, which is cheaper. |

### Palette

| Key | Used for |
|---|---|
| `body`, `bodyLight`, `bodyShade` | Body gradient (centre highlight → main → edge shade) |
| `wingFill`, `wingEdge` | Wings (fill can be `rgba(...)` for translucency) |
| `eye`, `eyeShine`, `mouth`, `cheek` | Face |
| `antenna`, `antennaTip` | Stalks, glowing tips |
| `band`, `lantern`, `lanternCore`, `glow` | Abdomen band, lantern gradient, ambient glow |
| `alarmLantern`, `alarmGlow` | Colours blended in by `pose.alarm` (fire alert) |

Built-in skins are `classic`, `ember`, `matrix` (matches the app's green) and `night`.

```ts
import { makeConfig, SKINS } from "./mascot/firefly";
const config = makeConfig({ palette: SKINS.matrix, glow: 2, eyeSize: 0.22 });
```

**Designing a look:** use the **Colours** section on `/firefly.html`, then click **Copy config**. That copies paste-ready `makeConfig({...})` code with every value. Changing *Body* in the picker also regenerates its highlight and shade; you can still edit those two separately.

---

## Pose: what he's doing

`FireflyPose` (in `types.ts`). Every field can be animated on its own.

| Field | Range | Meaning |
|---|---|---|
| `x`, `y` | px | Screen position (used by `<FireflyAgent/>`; the bare `<Firefly/>` ignores it) |
| `hover`, `offsetX` | px | Extra offset on top of `x/y` (bobbing, emote motion) |
| `rotation` | deg | Whole-body tilt (banking, wobble) |
| `turn` | deg | **3D turn around his vertical axis** (0 = facing you, 180 = back to you) |
| `scale` | ×1 | Overall size |
| `squash` | −0.3…0.3 | Squash and stretch (+ = wider and shorter) |
| `wings.upperL/upperR/lowerL/lowerR` | `{ lift, open }` | Per wing: `lift` in degrees (negative = raise), `open` 0…1 apparent width |
| `antennaL`, `antennaR` | deg | Offset from rest (negative = toward the centre) |
| `eyeOpenL`, `eyeOpenR` | 0…1 | Eyelids (0 = closed). Set them independently for a wink. |
| `lookX`, `lookY` | −1…1 | Gaze. Moves the eyes (and a little of the mouth) across the face. |
| `smile` | −1…1 | Frown … big smile |
| `mouthOpen` | 0…1 | Closed … wide open |
| `brow`, `browAmount` | −1…1, 0…1 | Brow slant (− angry/determined, + worried) and visibility |
| `blush` | 0…1 | Cheek blush |
| `lantern` | 0…1.5 | Lantern brightness |
| `alarm` | 0…1 | Blend to fire-alert colours |
| `whirl`, `whirlPhase` | 0…1, rad | Spin air effect strength and streak position |

### How `turn` works (the 3D illusion)

He isn't flipped like a flat card:
- The body is treated as a sphere, so it looks identical from every angle.
- Eyes, mouth and cheeks are placed on the sphere's surface. As he turns, they slide round, narrow toward the edge, and hide on the far side.
- Wings sit just behind the body's centre and antennae root on its upper front. Each is projected through the turn and depth-sorted, so it passes in front of or behind the body.
- The lantern hangs on the spin axis, so it doesn't move.

### Eyes

The white glints are **catch-lights**: reflections of a fixed light source, upper-right with a small second sparkle. They deliberately don't follow the gaze. Gaze is shown by moving the whole eye across the face, because glints that chase the cursor read as creepy white pupils.

---

## Moods

`MOODS` (in `moods.ts`) are personalities as data:

| Mood | Character |
|---|---|
| `idle` | Calm hover, gentle smile |
| `happy` | Big smile, blush, bouncier, slight sway |
| `excited` | Open grin, fast flapping, big bounce, bright pulsing lantern |
| `curious` | Head tilt, raised brows, antennae perked, looks up |
| `thinking` | Looks up and away, slow wings, thoughtful lantern pulse |
| `alert` | **Fire alert**: lantern and glow turn red-orange, angry brows, open mouth, fast frantic wings |
| `worried` | Worried brows, frown, drooping antennae, a hint of alarm colour |
| `sleepy` | Eyes nearly shut, slow lazy flaps, dim lantern, droopy |
| `sad` | Frown, sad brows, drooped wings and antennae, dim lantern |

Each `MoodSpec` has:
- `face` targets (`eyeOpen`, `smile`, `mouthOpen`, `brow`, `browAmount`, `blush`, `lookY`), which are eased toward;
- motion parameters: `flapHz`, `flapAmp`, `wingLift`, `bob`, `bobHz`, `lantern`, `pulseAmt`, `pulseHz`, `alarm`, `antenna`, `tilt`, `wiggle`.

**Add a mood:** add one entry in `moods.ts`. The preview page, gallery and types pick it up automatically.

```ts
proud: mood("Proud", { face: { smile: 0.9, lookY: -0.4 }, tilt: -6, lantern: 1.3, antenna: -12 }),
```

---

## Controller: behaviour

`FireflyController` builds a pose every frame from these layers:

1. **Mood targets**, eased.
2. **Procedural layers:**
   - wing flapping (the lower pair lags the upper);
   - hover bob;
   - random blinking;
   - lantern pulse;
   - antenna sway, plus drag behind motion.
3. **Flight:** seek, arrive, wander and follow, with banking into turns. He flaps faster while moving.
4. **Gaze:** at a point, or ahead in the direction of travel.
5. **One-shot emotes.**
6. **Talking mouth** while `say()` is active.
7. Your `override` fields last.

### API

| Member | Description |
|---|---|
| `setMood(name)` | Switch mood (eases over ~0.2 s). |
| `flyTo(x, y, { speed? })` | Fly to a point (px). Returns a **Promise** that resolves on arrival. Default top speed 420 px/s. |
| `follow(fn \| null)` | Continuously chase whatever point `fn()` returns (e.g. the cursor). `null` stops. |
| `lookAt(pt \| null)` | Eyes track a screen point; `null` looks ahead. |
| `play(emote)` | `"hop"` · `"spin"` · `"shake"` · `"nod"` · `"flutter"` |
| `spin({ onPeak? })` | Transformation spin (below). `onPeak` fires mid-whirl. |
| `say(text, seconds?)` | Shows `speech` in the bubble and animates the mouth. Default duration scales with text length. |
| `wander` + `bounds` | `wander = true` flies to random points inside `bounds = { x0, y0, x1, y1 }`. |
| `manual` | `true` = no procedural animation. You write `pose` yourself. |
| `override` | Partial pose forced on top every frame, e.g. `{ smile: -1, alarm: 1 }`. |
| `pose`, `mood`, `speech` | Current state (read freely). |
| `subscribe(fn)` | Called every frame with `(pose, controller)`. Returns an unsubscribe. |
| `start()` / `stop()` / `update(dt)` | Run the internal `requestAnimationFrame` loop, or stop it and step manually (useful for tests and recording). |

### Emotes

| Emote | Duration | What happens |
|---|---|---|
| `hop` | 0.55 s | Crouch (squash), jump up (stretch), land |
| `spin` | 1.9 s | Dreidel-style transformation spin (below) |
| `shake` | 0.6 s | Quick decaying head shake (no) |
| `nod` | 0.6 s | Two nods (yes) |
| `flutter` | 0.9 s | Rapid excited wing buzz with a little swell |

### The transformation spin

`ctl.spin()` (or `play("spin")`) is meant to feel like a stage outfit change:

1. **Up on his toe.** He rises, stretches slightly taller, and raises his wings.
2. **Whip round.** He spins about 5 turns in place in real 3D: the face goes round the back, and the wings swing in front of and behind the body. Angular speed ramps up fast, holds, then winds down, and the profile is normalised so he always ends facing forward.
3. **Air whirl.** Glowing streak rings and sparkles swirl around him on three horizontal rings, passing behind and in front of the body. Their strength follows spin speed (`pose.whirl`).
4. **Dreidel wobble.** As he slows, a growing tilt wobble, then he settles.

```ts
// Outfit change: swap his look at the peak of the spin
ctl.spin({ onPeak: () => setConfig(makeConfig({ palette: SKINS.ember })) });
```

---

## Recipes

**Follow the cursor and watch it**
```ts
const mouse = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
ctl.follow(() => ({ x: mouse.x + 70, y: mouse.y - 60 }));
ctl.lookAt(mouse);
```

**Scripted sequence**
```ts
ctl.setMood("excited");
await ctl.flyTo(200, 150);
await ctl.flyTo(700, 220);
ctl.spin();
ctl.setMood("happy");
ctl.say("Tour complete!");
```

**Hand animation with GSAP** (every part independent)
```ts
ctl.manual = true;
gsap.to(ctl.pose.wings.upperL, { lift: -40, yoyo: true, repeat: -1, duration: 0.08 });
gsap.to(ctl.pose, { eyeOpenR: 0.05, yoyo: true, repeat: 1, duration: 0.12 }); // wink
gsap.to(ctl.pose, { turn: 360, duration: 1, ease: "power2.inOut" });
```

**Keep procedural motion but force one thing**
```ts
ctl.override = { alarm: 1 };   // stay in fire-alert colours whatever the mood
ctl.override = {};             // back to normal
```

**Static or other renderers.** Use the bare renderer with any pose:
```tsx
<Firefly pose={{ ...DEFAULT_POSE, smile: 1, lookX: 0.5 }} config={makeConfig()} size={96} />
```

---

## Extending

- **New skin:** add an entry to `SKINS` in `config.ts`, or design one on the preview page and copy it.
- **New mood:** one entry in `moods.ts`.
- **New emote:**
  1. Add the name to `EmoteName`.
  2. Add a duration to `EMOTE_DURATION`.
  3. Add a `case` in `applyEmote()` in `controller.ts`. It receives `u` (0…1 progress) and adds offsets to the pose.
  4. Optionally add a button in `preview/main.tsx`.
- **New body part:** add its fields to `FireflyPose` (and `DEFAULT_POSE`), draw it in `Firefly.tsx`, and give it a depth if it should take part in the 3D turn (see the `parts` list).

## Performance

- Rendering is one small SVG of about 30 elements. The hook re-renders each animation frame, which is cheap for a handful of instances: the preview runs 10 at once.
- The glow uses an SVG blur filter, which is the most expensive part. Use `glow: 0` for many tiny instances.
- `stop()` the controller when he's off-screen.

## Preview page (`/firefly.html`)

- Click to fly; **Fly a tour** demo.
- Mood buttons, emotes, and the **Spin into** outfit-change buttons.
- Behaviour toggles: eyes follow cursor, follow cursor, wander.
- Speech input.
- Skins, size, wing size, the full colour editor and **Copy config**.
- **Manual pose** sliders for every individual part.
- A gallery of all moods running side by side.

In dev builds the preview's controller is available as `window.firefly`, e.g. `firefly.spin()` or `firefly.stop(); firefly.update(0.1)`.
