/**
 * Case 1 report — "Who should 311 send next?"
 *
 *   npm run case:311                    (5 Roads + 3 Waste crews, 5 jobs each, blizzard at noon)
 *   npm run case:311 -- sick            (a crew calls in sick instead)
 *   npm run case:311 -- blizzard 4 2 6  (4 Roads + 2 Waste crews, 6 jobs each)
 *
 * Same code as the app's Dispatch panel and Firefly (src/dispatch/ops311.ts), on the bundled
 * Open Calgary 311 sample.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load311, plan311, priority, supervisor8am, supervisorNoon, typeOf, type Disruption, type Score311 } from "../src/dispatch/ops311";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const disruption = (process.argv[2] ?? "blizzard") as Disruption;
const roads = Number(process.argv[3] ?? 5), waste = Number(process.argv[4] ?? 3), perCrew = Number(process.argv[5] ?? 5);

const load = load311(readFileSync(join(root, "public/data/cases/calgary_311_sample.csv"), "utf8"));
const p = plan311(load, { roads, waste, perCrew, disruption });
const h = (s: string) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 70 - s.length))}`);
const row = (name: string, s: Score311) => console.log(`${name.padEnd(26)} jobs ${String(s.jobs).padStart(3)}  safety jobs ${String(s.safetyJobs).padStart(2)}  safety left waiting ${String(s.safetyLeft).padStart(2)}  driving ${String(Math.round(s.km)).padStart(4)} km`);

h("1. Load");
console.log(`${load.rows} tickets. Closed ${load.closed}, duplicates ${load.duplicates}, missing location/date ${load.dropped} → ${load.open.length} open. Planning day: ${load.today}.`);

h("2. Priority (one line)");
console.log("priority = 10 × safety (1–5 by type) × weather + 2 × days waiting + 3 × similar reports within 400 m");
console.log("today's jobs = the highest priorities that fit the crews (ties: nearest to other work first);");
console.log("each goes to the crew it adds the least driving to (+ same community, same kind of job nearby)");
console.log("(no forecast in this report: weather counts in the app, and the noon blizzard brings its own)");

h(`3. ${p.crews.length} crews × ${p.perCrew} jobs: baseline vs priority`);
row("Baseline: oldest first", p.scores.fifo);
row("Priority + neighbourhoods", p.scores.morning);

h(`4. Disruption: ${disruption}`);
if (p.scores.noon) {
  row("Noon replan", p.scores.noon);
  console.log(`Jobs that changed crew: ${p.moved.length} · dropped to tomorrow: ${p.dropped.length} · new: ${p.newJobs.length}`);
  for (const m of p.moved.slice(0, 8)) console.log(`  moved   ${m.ticket.id.padEnd(12)} ${m.from} → ${m.to}  ${typeOf(m.ticket.service).label}, ${m.ticket.community}`);
  for (const d of p.dropped.slice(0, 8)) console.log(`  dropped ${d.ticket.id.padEnd(12)} (was ${d.from})  ${typeOf(d.ticket.service).label}, ${d.ticket.community}, priority ${priority(d.ticket, p.today, p.noonCtx)}`);
}

h("Crew sheets (morning)");
p.morning.routes.forEach((list, crew) => console.log(`  ${crew.padEnd(3)} ${list.map((t) => `${typeOf(t.service).label} @ ${t.community}`).join(" → ")}`));

h("5. Supervisor");
console.log(supervisor8am(p));
console.log(supervisorNoon(p));
