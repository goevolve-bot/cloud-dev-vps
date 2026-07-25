import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { AntigravityAdapter } from "./antigravity.js";

// agy --print emits plain text today, so parseEvents yields nothing on a real
// run. This covers the forward-compatible path: if agy ever grows structured
// output in the shape the rest of the pipeline already speaks, it works.
test("AntigravityAdapter extracts outcome and cost from structured output if it appears", async () => {
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

test("AntigravityAdapter containerCmd uses only flags agy actually accepts", () => {
  const adapter = new AntigravityAdapter();
  const cmd = adapter.containerCmd({ prompt: "do the thing", model: "gemini-3.1-pro-high" });
  assert.deepEqual(cmd, [
    "agy",
    "--print",
    "do the thing",
    "--model",
    "gemini-3.1-pro-high",
    "--dangerously-skip-permissions",
  ]);
  // Claude Code's flags, which this adapter used to copy. `agy --help` lists
  // neither, and agy rejects unknown flags before generating a single token.
  assert.ok(!cmd.includes("--output-format"));
  assert.ok(!cmd.includes("--verbose"));
});

test("AntigravityAdapter advertises model ids the CLI recognises", async () => {
  const adapter = new AntigravityAdapter();
  const ids = (await adapter.models()).map((m) => m.id);
  // Verified against `agy models` on the host, 2026-07-25.
  assert.ok(ids.includes("gemini-3.1-pro-high"));
  assert.ok(ids.includes("claude-sonnet-4-6"));
  // The ids this used to advertise are not in agy's list at all.
  assert.ok(!ids.includes("gemini-2.5-pro"));
  assert.ok(!ids.includes("claude-sonnet-5"));
});
