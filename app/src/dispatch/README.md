# Dispatch: how it decides

FIRE//WATCH's answer to two IEEE YP Industry Hackathon 2026 cases. In plain terms, here is what each one decides and why. The full method, numbers and references are in [METHODOLOGY.md §13](../../METHODOLOGY.md#13-dispatch-who-gets-the-next-crew).

| File | What it does |
|---|---|
| `crews.ts` | Case 3: rank wildfires for N crews, compare with biggest-first, cut crews, learn the weights |
| `ops311.ts` | Case 1: score Calgary 311 tickets, plan crews for the day, replan after a disruption |
| `router.ts` | Street routing for 311 crews over Calgary's real road network |
| `controller.ts` | Runs both against the app's live data; feeds the demo scenario the case fires |
| `agent.ts` | The same plans for Firefly (voice tools and typed Ask) |
| `store.ts` | Panel state, including the dispatcher's decisions |

Reports: `npm run case:crews`, `npm run case:311`. Tests: `tests/dispatch.test.ts`.

## Which wildfires get the next crew (Case 3)

**The question.** We have fewer crews than fires. Which fires get one, and which lose theirs when crews are cut by 20%?

**The score, in one line.** `priority = size × spread × people × crown`
- **Size:** hectares when the fire was assessed (log scale, so a 1,000 ha fire isn't 1,000 times a 1 ha fire).
- **Spread:** how fast the fire can run, in metres per minute. We take the faster of what was observed and what the Canadian Fire Behaviour Prediction System gives for that fuel type in that temperature, humidity and wind.
- **People:** towns within 30 km, weighted by distance, plus hospitals, schools, plants and power sites.
- **Crown:** crown fires (burning through the treetops) are far harder to hold.

**What "better" means.** Ranking on a fire's final size would be cheating: nobody knows the final size when sending a crew. So we grade differently. A good list puts crews on fires that were still small when assessed (≤ 200 ha) and went on to escape (> 200 ha). That's where a crew changes the outcome.

**Beating biggest-first.** With 40 crews our list reaches 28 of those escapes; biggest-first reaches 15. After a 20% cut (32 crews) it's 21 against 11.

**The improvement round.** The weights in the score start hand-set. The software then searches for better weights on two fire seasons and tests them on the third, which it never saw. It keeps the new weights only if they beat the hand-set ones on the unseen seasons (28 escapes against 21). Protecting people is policy, so the people weight never drops below a floor, even though closeness to towns doesn't predict escapes.

**What the duty officer gets.**
- The list.
- The fires that lose a crew in the cut (the lowest priorities on it).
- The big-but-slow or remote fires that biggest-first would have crewed instead.
- A spoken briefing from Firefly.

## Who 311 sends next (Case 1)

**The question.** Calgary has more open tickets than crews. Which jobs get done today, by which crew, and what changes when a blizzard hits or a crew calls in sick?

**The score, in one line.** `priority = 10 × safety × weather + 2 × days waiting + 3 × similar reports nearby`
- **Safety** comes from the service type, from ice and snow (5) and traffic signs (4) down to parking signs and new carts (1). Severity outranks age: a new traffic-sign ticket goes before a week-old parking sign.
- **Days waiting** adds 2 a day, so low-priority tickets don't wait forever.
- **Weather** comes from our own Calgary forecast:
  - snow and freezing raise ice and potholes (freeze-thaw);
  - heavy rain raises debris and potholes;
  - high wind raises signs and debris.
- **Similar reports nearby:** several reports of the same problem within 400 m mean a bigger problem.

**Planning the day.**
- Roads crews do Roads work and Waste & Recycling crews do waste work.
- Each crew takes its next job by priority minus travel. There's a bonus for staying in the same community, and another for doing the same kind of job nearby (the right equipment is on the truck).
- Compared with oldest-first, the same 8 crews do 25 safety jobs instead of 19, with 112 km of driving instead of 440.

**The disruption.**
- A blizzard adds a wave of ice calls and brings winter weather into the scores.
- A sick crew removes the busiest Roads crew.
- The replan keeps jobs on their morning crew where it can, and reports what changed crew, what moved to tomorrow, and what's new.
- When our forecast shows snow in Calgary, the panel suggests planning for the blizzard.

**Driving routes.** Every crew gets a route from the depot through its stops along Calgary's real streets.
- **The network:** every road the map draws, from OpenStreetMap: highways, arterials, collectors, residential streets and tracks. That's about 82,000 junctions.
- **The route:** the fastest drive at typical city speeds for each road class (35 km/h on residential streets up to 80 on highways).
- **On the map:** the route is drawn in the crew's colour.
- **In the crew card:** each leg shows its distance and minutes.
- **Shortest order:** re-orders a crew's stops for the least driving. With up to 7 stops it checks every order.
- **Limits:** OpenStreetMap's one-way and turn restrictions aren't in our bake, so routes are good drivable paths rather than turn-by-turn directions.

**What the dispatcher does.**
- Steps through the crews: each card shows the crew's stops and why each is on its list.
- Dispatches each crew (Enter).
- Opens **All tickets** to see everything, and marks a ticket urgent or holds it. The day replans at once.
