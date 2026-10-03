/**
 * Case 3 report — "Which wildfires get the next crew?"
 *
 *   npm run case:crews                 (40 crews, 20% cut)
 *   npm run case:crews -- 30 25        (30 crews, 25% cut)
 *
 * Same code as the app's Dispatch panel and Firefly (src/dispatch/crews.ts), on the bundled
 * Alberta 2023–2025 wildfire table, Alberta's communities (OSM) and the critical-sites list.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CRITICAL_ASSETS } from "../src/data/criticalAssets";
import { dutyBriefing, ESCAPE_HA, exposures, HAND_WEIGHTS, label, learnWeights, loadHistory, planCrews, type Weights } from "../src/dispatch/crews";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const N = Number(process.argv[2] ?? 40);
const CUT = Number(process.argv[3] ?? 20);

const hist = loadHistory(readFileSync(join(root, "public/data/cases/alberta_wildfires_2023_2025.csv"), "utf8"));
const places = (JSON.parse(readFileSync(join(root, "public/data/alberta/places.json"), "utf8")) as { places: { name: string; lat: number; lng: number; pop: number }[] }).places;
const assets = CRITICAL_ASSETS.filter((a) => a.regionId === "alberta");
const inp = { fires: hist.fires, exposures: exposures(hist.fires, places, assets) };

const h = (s: string) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 70 - s.length))}`);
const w = (x: Weights) => `size^${x.size} · growth^${x.growth} · people^${x.people} · crown×${x.crown}`;

h("1. Load");
console.log(`${hist.rows} fires (2023–2025). Dropped for missing size or coordinates: ${hist.dropped}. Kept: ${hist.fires.length}.`);
console.log(`Filled in: ${Object.entries(hist.imputed).map(([k, v]) => `${k} ${v}`).join(", ")} (weather → table median: ${hist.medians.tempC} °C, ${hist.medians.rh}% RH, ${hist.medians.windKmh} km/h; fuel → M-2 mixedwood; spread → FBP only).`);

h("2. Score (one line)");
console.log("priority = (1 + log10(1 + ha))^a × (1 + ROS/10)^b × (1 + log10(people)/3)^c × (crown ? d : 1)");
console.log("ROS = max(observed spread, FBP rate of spread for the fuel + weather); people within 30 km incl. hospitals, schools, plants.");
console.log(`Escape = at most ${ESCAPE_HA} ha when assessed, past ${ESCAPE_HA} ha (class E) at the end: where a crew changes the outcome. Graded afterwards from the final size, never used to rank.`);

h("3. Improvement round (train on two seasons, test on the third)");
const learned = learnWeights(inp, N);
for (const t of learned.folds) {
  console.log(`held out ${t.testYears[0]} (${t.test.crews} crews): baseline ${t.test.baseline} · round 1 ${t.test.hand} · round 2 ${t.test.tuned} of ${t.test.total} escapes   [fit on ${t.trainYears.join("+")}: ${w(t.weights)}]`);
}
const ho = learned.heldOut;
console.log(`Held-out total: baseline ${ho.baseline} · round 1 ${ho.hand} · round 2 ${ho.tuned} of ${ho.total} → ${learned.kept ? "tuned weights kept, refit on all seasons" : "tuning rejected, hand weights kept"}`);
const weights = learned.weights;
console.log(`Weights used: ${w(weights)} (round 1 was ${w(HAND_WEIGHTS)})`);

h(`4. ${N} crews, then ${CUT}% fewer`);
const round1 = planCrews(inp, N, CUT, HAND_WEIGHTS);
const plan = planCrews(inp, N, CUT, weights);
const g = plan.grades!;
const line = (name: string, x: typeof g.ours, n: number) => console.log(`${name.padEnd(30)} ${String(n).padStart(3)} crews  escapes reached ${String(x.escapesCaught).padStart(2)}/${x.escapesTotal}  later growth ${Math.round(x.growthHa).toLocaleString("en-CA").padStart(9)} ha  people ${Math.round(x.people).toLocaleString("en-CA")}`);
line("Baseline: biggest first", g.baseline, plan.crews);
line("Round 1: hand weights", round1.grades!.ours, plan.crews);
line("Round 2: tuned weights", g.ours, plan.crews);
line("Baseline after cut", g.baselineCut, plan.cutCrews);
line("Ours after cut", g.cut, plan.cutCrews);

h("5. Fires that lost a crew");
for (const s of plan.lostCrew) console.log(`  ${label(s).padEnd(34)} ${s.reason}`);

h("Top of the list");
plan.pickedCut.slice(0, 10).forEach((s, i) => console.log(`${String(i + 1).padStart(3)}. ${label(s).padEnd(34)} ${s.reason}`));

h("Duty officer");
console.log(dutyBriefing(plan));
