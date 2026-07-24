import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { ClaudeAdapter } from "./claude.js";

test("ClaudeAdapter parses a stream-json and extracts outcome and cost", async () => {
  const adapter = new ClaudeAdapter();
  const recordedStream = [
    JSON.stringify({ type: "system", message: "Starting agent..." }),
    JSON.stringify({ type: "assistant", message: "Thinking..." }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Successfully implemented feature X.",
      total_cost_usd: 0.042,
      usage: {
        input_tokens: 1500,
        output_tokens: 420,
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
  assert.equal(outcome, "Successfully implemented feature X.");

  const cost = adapter.extractCost(events);
  assert.deepEqual(cost, {
    usd: 0.042,
    tokensIn: 1500,
    tokensOut: 420,
  });
});
