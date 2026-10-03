# TODO

What's left before judging (IEEE YP Industry Hackathon, Oct 2–4, 2026). Owners are tagged: **[Minh]** for everything ElevenLabs, **[Nick]** for everything Databricks.

## ElevenLabs voice agent [Minh]

The voice agent's settings live in [`app/src/firefly/AGENT.md`](app/src/firefly/AGENT.md). The dashboard is behind it: it's missing the two tools that cover all the data and the dispatching.

- [ ] **[Minh]** Add the `ask_data` client tool. Parameters are in the AGENT.md tool table. Turn "Wait for response" on.
- [ ] **[Minh]** Add the `do_dispatch` client tool, the same way.
- [ ] **[Minh]** Add the `set_regions` client tool (from PR #15), and add `air`, `traffic` and `bloom` to `set_layer`'s layer list.
- [ ] **[Minh]** Check the agent has all 16 client tools, with names and parameters matching the AGENT.md table. `tests/llm.test.ts` keeps that table in sync with the code, so the table is the source of truth.
- [ ] **[Minh]** Paste the new system prompt sections from AGENT.md: "Data questions" and "Dispatching".
- [ ] **[Minh]** Add the deployed site's domain to the agent's allowlist. It rejects `localhost`, so test voice on the deployed site, or allow localhost temporarily.
- [ ] **[Minh]** Live voice test: hold the mic and ask "what's next", "dispatch it", "potholes in Beltline", "mark that ticket urgent", "any water bombers flying?". In the ElevenLabs conversation log, check it called `ask_data` / `do_dispatch` rather than guessing.
- [ ] **[Minh]** Check there are enough ElevenLabs credits for rehearsals plus the demo.

## Databricks AI model [Nick]

Typed questions go to a model on Databricks Model Serving through the data server ([`app/server/ai.ts`](app/server/ai.ts), [`app/src/firefly/llm.ts`](app/src/firefly/llm.ts)). So far it has only been tested against a mock model.

- [ ] **[Nick]** Confirm the workspace is Databricks Free Edition. The legacy Community Edition has no Model Serving or Apps.
- [ ] **[Nick]** Under Serving, check `databricks-meta-llama-3-3-70b-instruct` exists. To use a different endpoint (e.g. a Claude one), set `FIREWATCH_AI_ENDPOINT`.
- [ ] **[Nick]** Run locally with `DATABRICKS_HOST` and `DATABRICKS_TOKEN` (see [RUNBOOK.md](RUNBOOK.md)). http://localhost:8787/api/ai should show `"available": true`.
- [ ] **[Nick]** Real-model test in the app, where each reply should show "AI · <model>" and the tools it used:
  - "who's next?" then "dispatch it"
  - "find pothole tickets in Beltline and mark the worst one urgent"
  - "which fires lost a crew if we cut 20%?"
  - "is there smoke in Calgary?"
  - "what should crew R1 do today?"
- [ ] **[Nick]** If the model answers without calling tools, or calls them badly, try a stronger endpoint before changing the prompt.
- [ ] **[Nick]** Deploy the data server (`npm run deploy:databricks`). Give the app's service principal "Can query" on the endpoint, then check `<app url>/api/ai` (see [DEPLOY-DATABRICKS.md](DEPLOY-DATABRICKS.md)).
- [ ] **[Nick]** Redeploy the Cloudflare Pages site so its proxy forwards `POST /api/ai/chat`.
- [ ] **[Nick]** Check Free Edition's rate limits are enough for the demo. If the model fails, Firefly falls back to ElevenLabs, then to answers from the app's own data.

## Merge and deploy

- [ ] Merge the stacked branches into `main`, in order:
  1. `feature/next-crew-ranking`
  2. `feature/wildfire-dispatch`
  3. `feature/firefly-dispatch-ai`
- [ ] Run `npm test` and `npm run build` on `main` after the merge.

## Demo prep

- [ ] Rehearse the demo end to end on the deployed site, with the data server, the Databricks model and the voice agent all live.
- [ ] Have a fallback ready if a live source (Open Calgary, CWFIS, adsb.lol) is down: the case data in demo mode.
- [ ] Line up a slide or talking point for each rubric item: autonomous reasoning (the model chaining tools), real problem, execution, commercialization, demo.
