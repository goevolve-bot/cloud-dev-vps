import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { AntigravityAdapter } from "./antigravity.js";

test("AntigravityAdapter parses stream-json and extracts outcome and cost", async () => {
  const adapter = new AntigravityAdapter();
  const recordedStream = [
    JSON.stringify({ type: "system", message: "Starting agy..." }),
    JSON.stringify({ type: "assistant", message: "Working on it..." }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Implemented feature Y successfully.",
      total_cost_usd: 0.015,
      usage: {
        input_tokens: 800,
        output_tokens: 200,
      },
    }),
  ].join("\n") + "\n";

  const stream = Readable.from(recordedStream);
  const events = [];
  for await (const event of adapter.parseEvents(stream)) {
    events.push(event);
  }

  assert.equal(events.length, 3);
  assert.equal(events[0].type, "system");
  assert.equal(events[1].type, "assistant");
  assert.equal(events[2].type, "result");

  const outcome = adapter.extractOutcome(events);
  assert.equal(outcome, "Implemented feature Y successfully.");

  const cost = adapter.extractCost(events);
  assert.deepEqual(cost, {
    usd: 0.015,
    tokensIn: 800,
    tokensOut: 200,
  });
});

test("AntigravityAdapter containerCmd uses agy with dangerously-skip-permissions", () => {
  const adapter = new AntigravityAdapter();
  const cmd = adapter.containerCmd({ prompt: "do the thing", model: "gemini-2.5-pro" });
  assert.equal(cmd[0], "agy");
  assert.ok(cmd.includes("--dangerously-skip-permissions"));
  assert.ok(cmd.includes("--output-format"));
  assert.ok(cmd.includes("stream-json"));
  assert.ok(cmd.includes("gemini-2.5-pro"));
});
