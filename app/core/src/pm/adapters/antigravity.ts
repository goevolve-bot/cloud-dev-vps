import { Readable } from "node:stream";
import * as readline from "node:readline";
import type { ProviderAdapter, Model, RunEvent } from "./index.js";

/**
 * Antigravity (agy) adapter — mirrors the ClaudeAdapter interface so the
 * runner can launch agy runs identically to claude runs.  agy emits the same
 * stream-json format as `claude --output-format stream-json`, so event parsing
 * and cost/outcome extraction are identical.
 */
export class AntigravityAdapter implements ProviderAdapter {
  containerCmd(opts: { prompt: string; model: string }): string[] {
    return [
      "agy",
      "-p",
      opts.prompt,
      "--model",
      opts.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
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
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (via Antigravity)" },
      { id: "claude-3-7-sonnet-latest", name: "Claude 3.7 Sonnet (via Antigravity)" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (via Antigravity)" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (via Antigravity)" },
    ];
  }
}
