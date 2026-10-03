import assert from "node:assert/strict";
import { test } from "node:test";
import { clipSpeech, prepareSpeech } from "../server/speak.ts";

test("clipSpeech keeps a short line", () => {
  assert.equal(clipSpeech("  Calgary is dry.  "), "Calgary is dry.");
});

test("clipSpeech stops on a sentence", () => {
  const text = `One sentence here. ${"word ".repeat(400)}`;
  assert.equal(clipSpeech(text, 80), "One sentence here.");
});

test("prepareSpeech needs a key and some text", () => {
  assert.deepEqual(prepareSpeech("Hello", ""), { error: "missing_key" });
  assert.deepEqual(prepareSpeech("   ", "key"), { error: "empty" });
  assert.deepEqual(prepareSpeech("Hello", "key"), { text: "Hello" });
});
