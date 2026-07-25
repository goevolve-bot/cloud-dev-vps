import { Readable } from "node:stream";
import * as readline from "node:readline";
import type { ProviderAdapter, Model, RunEvent } from "./index.js";

/**
 * Antigravity (agy) adapter.
 *
 * This used to be a copy of ClaudeAdapter on the assumption that `agy` accepts
 * Claude Code's flags and emits the same stream-json. It does not, and the
 * assumption had never been checked against a real CLI (the TODO in
 * docs/pm-remediation/README.md). `agy --help` on the host lists exactly one
 * output mode — `-p`/`--print`, "Run a single prompt non-interactively and
 * print the response" — and no `--output-format` or `--verbose` at all, so the
 * old command line would have been rejected as unknown flags before a single
 * token was generated.
 *
 * The consequence for the rest of the system is that an agy run produces
 * **plain text**, not events. queue.ts already copes: it decides success from
 * the container's exit code and only lets a JSON `result` event downgrade an
 * exit-0 run, so the empty extractions below cost a per-run cost figure and a
 * result summary, not correctness.
 */
export class AntigravityAdapter implements ProviderAdapter {
  containerCmd(opts: { prompt: string; model: string }): string[] {
    return ["agy", "--print", opts.prompt, "--model", opts.model, "--dangerously-skip-permissions"];
  }

  /**
   * Kept parsing JSON lines so that a future agy which grows structured output
   * starts working without a code change; today it simply yields nothing.
   */
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

  /**
   * null, not a zero-filled record: agy reports no usage or spend anywhere in
   * `--print` output. Returning zeros would make the costs page state that
   * Antigravity runs are free, which is a different claim from "not known".
   */
  extractCost(events: RunEvent[]): { usd: number; tokensIn: number; tokensOut: number } | null {
    const resultEvent = events.find((e) => e.type === "result");
    if (!resultEvent) return null;
    const usd = typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : 0;
    const tokensIn = resultEvent.usage?.input_tokens ?? 0;
    const tokensOut = resultEvent.usage?.output_tokens ?? 0;
    return { usd, tokensIn, tokensOut };
  }

  /**
   * From `agy models` on the host, 2026-07-25. None of the ids this previously
   * advertised (claude-sonnet-5, gemini-2.5-pro, …) are accepted by the CLI.
   * agy bakes the reasoning effort into the id rather than taking a separate
   * flag, hence the -low/-medium/-high suffixes.
   */
  async models(): Promise<Model[]> {
    return [
      { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (high effort)" },
      { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (low effort)" },
      { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (high effort)" },
      { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (medium effort)" },
      { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (low effort)" },
      { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (high effort)" },
      { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (medium effort)" },
      { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (low effort)" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (via Antigravity)" },
      { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking (via Antigravity)" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (medium effort)" },
    ];
  }
}
