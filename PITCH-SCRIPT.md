# Pitch Script

The spoken script for the three-minute pitch on `/pitch.html` (see [RUNBOOK.md](RUNBOOK.md) to run it).
It follows the deck's own flow: each line is written for where the camera is and what's moving
on that step.

**Status: draft, not yet approved.** Once it's approved, update the on-screen captions in
[`app/src/pitch/story.ts`](app/src/pitch/story.ts) to match **Proposed on-screen text** below.

## Speakers

| Speaker | Part | Steps |
|---|---|---|
| **Speaker 1** (lead) | Opening, the two turns, the close | 0, 5, 14–16 |
| **Speaker 2** | City dispatch: Calgary 311 | 1–4 |
| **Speaker 3** | Wildfire dispatch and Firefly | 6–9 |
| **Speaker 4** | Prediction and weather | 10–13 |

One person presses → every time. **Press on the last word of the line**, not after it: the
camera takes 2–5 s to arrive, and the next speaker starts as it settles.

## The flow

Timings were measured on the running deck. "Moves" is how long the camera flies before it settles.

| Step | Where the camera is | What happens | Moves | Hold |
|---|---|---|---|---|
| 0 | Calgary, 3D model of the city, orbiting | Title | 3 s | 20 s |
| 1 | Down to street level on one block | A 311 pin drops on the ticket | 3.6 s | 8 s |
| 2 | Same block, swings around | The priority card opens | 2.6 s | 9 s |
| 3 | Pulls up over the neighbourhood | The crew's route draws, the truck drives it | 2.6 s | 8 s |
| 4 | Above all of Calgary | Every crew's route at once | 2.8 s | 8 s |
| 5 | Zooms out of the city | Alberta appears around Calgary | 4.2 s | 5 s |
| 6 | All of Alberta, slow orbit | 2023–2025 fires replay, risk lights up | 1.6 s | 10 s |
| 7 | North to the fire cluster | Crews and aircraft launch from the bases | 3 s | 12 s |
| 8 | Same | Firefly pops in, the question types, he answers; the camera follows him to one fire | 4.5 s | ~19 s |
| 9 | Close on fire HWF121, orbiting | The fire's numbers | — | 5 s |
| 10 | Same fire | Ticker: Tomorrow at 2 s, Day 2 at 5 s, Day 3 at 8 s; the projection grows | — | 10 s |
| 11 | Same fire | Rain switches on, then a storm settles over the fire | — | 7 s |
| 12 | Flies to wherever snow is forecast (today: northern BC) | A spotlight follows the camera | 3.6 s | 6 s |
| 13 | Back out over Alberta | Wind streamlines over everything | 3.2 s | 6 s |
| 14 | Alberta | Replay off: this is **today's real data** | 3 s | 5 s |
| 15 | The big pull-back to all of Canada | Every province revealed, live counts | 5 s | 10 s |
| 16 | Canada | Closing title | — | 12 s |

Total holds: about 2:41, which leaves roughly 20 s of slack for pauses.

## Script

*[beat]* means a full one-second pause. Bold words get the stress. *Italics* are stage directions.

### 0 · Calgary, the title (S1)

*The deck opens on the 3D model of Calgary, slowly orbiting. Let it turn for a second before speaking.*

> This is Calgary. For most of us in this room, it's **home**.
> *[beat]*
> And if you've lived in Alberta, you've seen the sky turn **orange**.
> You've seen Fort McMurray empty out on **one highway**. You've seen Jasper burn.
> You've had summers where you couldn't **breathe** outside.
> *[beat]*
> You don't need a statistic. You **remember**.
> Someone has to answer that call. This is for them.

### 1–4 · Calgary 311 (S2)

**1** *The camera dives to street level. Start talking as it lands, then the pin drops.*
> It starts with something small. A call to 311, right here.

**2** *The priority card opens.*
> The city has tens of thousands of open tickets. We score every one of them on safety, today's
> weather, how long it's waited and how many people called it in, so the **dangerous** ones go first.

**3** *The camera rises and the route draws itself.*
> Then we route a crew on real streets, every stop in order.

**4** *Every crew's route across Calgary.*
> Do that for every crew, all day, and the city gets **more safety jobs done** than
> first-come, first-served.

### 5 · Out of the city (S1)

*Press right after Speaker 2's last word. Wait until Alberta has appeared around the city, then speak.*

> But it's not just Calgary.

### 6–9 · Wildfire dispatch (S3)

**6** *Alberta, and the fire seasons replaying.*
> This is three real fire seasons in Alberta, replayed. Every fire is ranked by size, by how fast
> it spreads in that fuel and that weather, and by **how many people** are in its way.

**7** *The camera heads north and the aircraft launch.*
> From twelve bases, crews and aircraft go out. Skimmers scoop the nearest lake, tankers reload,
> crews drive or fly in. And our ranking reaches **almost twice as many** of the fires that later
> escaped as going biggest-first.

**8** *Say this as you press. Then stop talking: the question types out and Firefly answers (~15 s).*
> Or a dispatcher can just **ask**.

*Firefly answers on his own, and the camera follows him to the fire.*

**9** *Close on the fire.*
> That's one fire, today.

### 10–13 · Prediction and weather (S4)

**10** *Same fire. The day ticker starts 2 s in.*
> But where will it be **tomorrow**?
> *Stay quiet while Tomorrow and Day 2 tick over and the projection grows.*
> We grow it day by day across the real fuel map, pushed by each day's forecast wind.

**11** *Rain switches on, then the storm settles over the fire.*
> Then the rain comes. The fuel soaks, the risk drops, and the fire **stalls**.

**12** *The camera flies off to the snow.*
> And up north, where it's freezing, it comes down as snow, and that slows fire too.

**13** *Back over Alberta, the wind streamlines appear.*
> And the wind drives every single path.

### 14–16 · Canada and the close (S1)

**14** *Alberta again, but the replay is off.*
> Everything you just saw runs on **today's** data. And wildfires don't always start in Alberta.

**15** *The big pull-back. Let it reveal Canada for two seconds before speaking.*
> Every province. Every territory. **Live**, right now.

**16** *The closing title.*
> Next time the sky turns orange, someone has to decide where the first crew goes.
> We want them deciding with **everything on one map**.
> *[beat]*
> This is FIRE//WATCH. Thank you.

## What changes from day to day

The deck fills these in live, so the script never says them out loud. Read them off the screen
on the rehearsal run.

| Step | Live value | On Oct 4 |
|---|---|---|
| 1 | The 311 ticket and its community | Traffic sign or marking down, Richmond |
| 2 | Open tickets | 24,637 |
| 3 | Crew, distance, drive time, stops | R1 · 12.4 km · 11 min · 5 stops |
| 4 | Safety jobs, by priority vs oldest-first | 25 vs 22 |
| 7 | Escaped fires reached, ours vs biggest-first | 28 vs 15 |
| 12 | Where the snow is | 17 mm near Telegraph Creek, BC |
| 15 | Active wildfires, satellite hotspots | 95 · 161 |

Steps 8–11 are the **fixed** replay (HWF121, 47 km NW of Garden River, 1,000 ha, crowning), so
Firefly's answer is the same every time.

If step 7 ever reads closer than about 2-to-1, change "almost twice as many" to "more".

## Proposed on-screen text

The speakers now say most of what the captions spell out, so the proposal shortens each
caption to a title plus only the live numbers. `{…}` is a value already computed in `story.ts`.

| Step | Title now | Proposed title | Proposed body |
|---|---|---|---|
| 0 | FIRE//WATCH | FIRE//WATCH | One map, from the first 311 call to the last wildfire. |
| 1 | A call comes in. | A call comes in. | {type} in {community} |
| 2 | Why it jumps the queue. | Why it jumps the queue. | #{rank} of {open} open tickets |
| 3 | Crew {crew} is on its way. | Crew {crew} is on its way. | {km} km · {min} min · {stops} stops |
| 4 | {n} safety jobs today. Oldest-first gets {m}. | {n} safety jobs today. | Oldest-first: {m} |
| 5 | But it's not just Calgary. | But it's not just Calgary. | |
| 6 | We're all affected by wildfires. | We're all affected by wildfires. | Alberta 2023–2025, replayed |
| 7 | Crews and aircraft, from 12 bases. | Crews and aircraft, from 12 bases. | Escaped fires reached: ours {a} · biggest-first {b} |
| 8 | Or just ask. | Or just ask. | |
| 9 | One fire. | One fire. | {ha} ha · {ros} m/min · {km} km {dir} of {town} |
| 10 | Where it could go. | Where it could go. | A scenario, not an official forecast. |
| 11 | Then the rain comes. | Then the rain comes. | |
| 12 | And snow where it's freezing. | And snow where it's freezing. | {mm} mm near {place} |
| 13 | And the wind drives every path. | The wind drives every path. | |
| 14 | But wildfires don't always start in Alberta. | But wildfires don't always start in Alberta. | Today's data |
| 15 | Every province. Every territory. Live. | Every province. Every territory. Live. | {fires} wildfires · {hotspots} hotspots |
| 16 | FIRE//WATCH | FIRE//WATCH | Dispatch · Prediction · Weather · All of Canada |

Keep "A scenario, not an official forecast." on step 10. Judges will ask about it.

## Delivery notes

- **The opening carries the pitch.** S1 should slow down, look at the judges, and actually take
  each *[beat]*. Don't read it off a phone.
- **Don't talk over the camera.** Each move is 2–5 s. Press on your last word, and the next
  speaker starts when the camera settles.
- **Firefly's voice:** `app/public/pitch/firefly-answer.mp3` doesn't exist yet (see [TODO.md](TODO.md)).
  Without it, step 8 shows his speech bubble in silence for about 14 s. Either record the clip or
  have S3 read the bubble aloud.
- **Step 10 is the hardest timing.** Don't press until the ticker reaches Day 3 (8 s in).
- **Rehearse with a stopwatch.** Aim for 2:50.

## Facts to check before the pitch

- Fort McMurray, May 2016: the whole city (about 88,000 people) was evacuated.
- Jasper, July 2024: the wildfire burned into the town.
- The script names no numbers for these, so a check is enough. No sources are needed on stage.
