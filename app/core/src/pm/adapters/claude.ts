import { Readable } from "node:stream";
import * as readline from "node:readline";
import type { ProviderAdapter, Model, RunEvent } from "./index.js";

export class ClaudeAdapter implements ProviderAdapter {
  containerCmd(opts: { prompt: string; model: string }): string[] {
    return [
      "claude",
      "-p",
      opts.prompt,
      "--model",
      opts.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions"
    ];
  }

  async *parseEvents(stdout: Readable): AsyncIterable<RunEvent> {
    const rl = readline.createInterface({
      input: stdout,
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // ignore lines that are not valid JSON
      }
    }
  }

  extractOutcome(events: RunEvent[]): string {
    const resultEvent = events.find((e) => e.type === "result");
    if (resultEvent && typeof resultEvent.result === "string") {
      return resultEvent.result;
    }
    return "";
  }

  extractCost(events: RunEvent[]): { usd: number; tokensIn: number; tokensOut: number } | null {
    const resultEvent = events.find((e) => e.type === "result");
    if (!resultEvent) return null;
    const usd = typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : 0;
    const tokensIn = resultEvent.usage?.input_tokens ?? 0;
    const tokensOut = resultEvent.usage?.output_tokens ?? 0;
    return { usd, tokensIn, tokensOut };
  }

  async models(): Promise<Model[]> {
    return [
      { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku" },
      { id: "claude-3-opus-latest", name: "Claude 3 Opus" },
    ];
  }
}
