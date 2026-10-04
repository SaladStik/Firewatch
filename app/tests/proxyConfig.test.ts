import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../functions/api/[[path]].ts";

const four = { DATABRICKS_APP_URL: "https://app", DATABRICKS_HOST: "https://host", DATABRICKS_CLIENT_ID: "id", DATABRICKS_CLIENT_SECRET: "sec" };

test("plain string bindings are read", async () => {
  const { vals, missing } = await config(four as never);
  assert.deepEqual(missing, []);
  assert.equal(vals.DATABRICKS_CLIENT_SECRET, "sec");
});

test("a Secrets Store binding is read through get(), not treated as missing", async () => {
  // This is the shape that used to look identical to an unset variable.
  const env = { ...four, DATABRICKS_CLIENT_SECRET: { get: async () => "from-store" } };
  const { vals, missing } = await config(env as never);
  assert.deepEqual(missing, []);
  assert.equal(vals.DATABRICKS_CLIENT_SECRET, "from-store");
});

test("an unset variable says so", async () => {
  const { missing } = await config({ ...four, DATABRICKS_CLIENT_SECRET: undefined } as never);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^DATABRICKS_CLIENT_SECRET: not set$/);
});

test("set but empty, and bound-but-unreadable, are told apart", async () => {
  const empty = await config({ ...four, DATABRICKS_CLIENT_SECRET: "" } as never);
  assert.match(empty.missing[0], /set but empty/);
  const opaque = await config({ ...four, DATABRICKS_CLIENT_SECRET: { nope: 1 } } as never);
  assert.match(opaque.missing[0], /bound as object .*no get\(\)/);
  const blank = await config({ ...four, DATABRICKS_CLIENT_SECRET: { get: async () => "" } } as never);
  assert.match(blank.missing[0], /get\(\) returned nothing/);
});

test("a directly set token stands in for the host and principal, but not the app url", async () => {
  const { missing } = await config({ DATABRICKS_APP_URL: "https://app", DATABRICKS_TOKEN: "t" } as never);
  assert.deepEqual(missing, []);
  const noUrl = await config({ DATABRICKS_TOKEN: "t" } as never);
  assert.equal(noUrl.missing.length, 1);
  assert.match(noUrl.missing[0], /^DATABRICKS_APP_URL/);
});
