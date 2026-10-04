# TODO

What's left before judging (IEEE YP Industry Hackathon, Oct 2–4, 2026). Owners are tagged: **[Minh]** for everything ElevenLabs, **[Nick]** for everything Databricks.

## ElevenLabs voice agent [Minh]

The voice agent's settings live in [`app/src/firefly/AGENT.md`](app/src/firefly/AGENT.md). The dashboard is behind it: it's missing the two tools that cover all the data and the dispatching.

- [ ] **[Minh]** Add the `ask_data` client tool. Parameters are in the AGENT.md tool table. Turn "Wait for response" on.
- [ ] **[Minh]** Add the `do_dispatch` client tool, the same way.
- [ ] **[Minh]** Add the `set_regions` client tool (from PR #15), and add `air`, `traffic` and `bloom` to `set_layer`'s layer list.
- [ ] **[Minh]** Check the agent has all 17 client tools (including `find_risk_areas` from PR #16), with names and parameters matching the AGENT.md table. `tests/llm.test.ts` keeps that table in sync with the code, so the table is the source of truth.
- [ ] **[Minh]** Paste the new system prompt sections from AGENT.md: "Data questions" and "Dispatching".
- [ ] **[Minh]** Add the deployed site's domain to the agent's allowlist. It rejects `localhost`, so test voice on the deployed site, or allow localhost temporarily.
- [ ] **[Minh]** Live voice test: hold the mic and ask "what's next", "dispatch it", "potholes in Beltline", "mark that ticket urgent", "any water bombers flying?". In the ElevenLabs conversation log, check it called `ask_data` / `do_dispatch` rather than guessing.
- [ ] **[Minh]** Check there are enough ElevenLabs credits for rehearsals plus the demo.

## Databricks AI model [Nick]

Typed questions go to a model on Databricks Model Serving through the data server ([`app/server/ai.ts`](app/server/ai.ts), [`app/src/firefly/llm.ts`](app/src/firefly/llm.ts)). So far it has only been tested against a mock model.

- [x] **[Nick]** Confirm the workspace is Databricks Free Edition. The legacy Community Edition has no Model Serving or Apps. — Both work: 12 serving endpoints and the app is deployed. Consistent with Free Edition: its compute stopped itself overnight with "stopped due to workspace or account status", which is the 24-hour rule.
- [x] **[Nick]** Under Serving, check `databricks-meta-llama-3-3-70b-instruct` exists. — Exists and READY, along with 11 others (`databricks-gpt-oss-120b`, `databricks-llama-4-maverick`, …) if a stronger one is wanted via `FIREWATCH_AI_ENDPOINT`.
- [x] **[Nick]** Run locally and check `/api/ai`. — `{"available":true,"provider":"databricks","model":"databricks-meta-llama-3-3-70b-instruct"}`. A personal access token is not needed: `ai.ts` also takes `DATABRICKS_CLIENT_ID`/`_SECRET`, and the service principal in the repo-root `.env` works. (Apps reject PATs anyway — see DEPLOY-DATABRICKS.md.)
- [x] **[Nick]** Real-model test. — All six questions call the right tool first try, both locally and through the deployed app:
  - "who's next?" → `ask_data(wildfire_queue)`
  - "dispatch it" → `do_dispatch(dispatch_fire)`
  - "find pothole tickets in Beltline and mark the worst one urgent" → `ask_data(tickets, Beltline, pothole)`
  - "which fires lost a crew if we cut 20%?" → `plan_crews(crews 12, cut 20)`
  - "is there smoke in Calgary?" → `ask_data(air_quality, Calgary)`
  - "what should crew R1 do today?" → `ask_data(crews_311)`
- [x] **[Nick]** If the model calls tools badly, try a stronger endpoint before changing the prompt. — Only "what should crew R1 do today?" was wrong: it opened the 311 desk instead of reading the crew's stops. `databricks-gpt-oss-120b` got it wrong too (it called `plan_311`), so it was tool choice, not model strength. Fixed with one rule in the `llm.ts` system prompt ("read before you open"); the explicit "open the 311 desk" and "plan 311 with 6 roads crews" still route to `open_dispatch` and `plan_311`.
- [x] **[Nick]** Deploy the data server, give the app's service principal "Can query" on the endpoint, check `<app url>/api/ai`. — Deployed; `/api/ai` is available and a chat returns through it. **The "Can query" grant is not needed**: a plain service principal can call a Foundation Model endpoint already (tested), and these system endpoints have no id for Terraform's `serving_endpoint_id` anyway.
- [ ] **[Nick]** Redeploy the Cloudflare Pages site so its proxy forwards `POST /api/ai/chat`. — The function already handles POST (method, body, `X-Forwarded-For` for per-device limits). Only the deploy is left, and it needs Cloudflare credentials: `wrangler login` then `npm run deploy:pages`, or let the connected git build run. The site also needs `VITE_ELEVENLABS_AGENT_ID` as a Pages build variable, since `app/.env` is gitignored.
- [x] **[Nick]** Check Free Edition's rate limits are enough for the demo. — They are not, unaided: five chats in a row hit `429 REQUEST_LIMIT_EXCEEDED: Exceeded workspace QPS rate limit`. One question costs up to `MAX_STEPS` = 6 model calls, so this is reachable in normal use and used to fail the whole answer. `server/ai.ts` now backs off and retries a 429 (3 tries, 1.2 s growing); eight concurrent chats then all succeeded. A sustained 429 now returns 503 "the model is busy" rather than a raw 502.

## Merge and deploy

- [x] Merge the stacked branches into `main`, in order:
  1. `feature/next-crew-ranking`
  2. `feature/wildfire-dispatch`
  3. `feature/firefly-dispatch-ai`
- [x] Run `npm test` and `npm run build` on `main` after the merge.

## Demo prep

- [ ] Rehearse the demo end to end on the deployed site, with the data server, the Databricks model and the voice agent all live.
- [ ] Have a fallback ready if a live source (Open Calgary, CWFIS, adsb.lol) is down: the case data in demo mode.
- [ ] Line up a slide or talking point for each rubric item: autonomous reasoning (the model chaining tools), real problem, execution, commercialization, demo.
