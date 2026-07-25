import { Readable } from "node:stream";

export interface Model {
  readonly id: string;
  readonly name: string;
}

/**
 * A parsed line of `--output-format stream-json` output. Every provider CLI
 * emits its own event shapes; only the fields adapters actually read are
 * typed, with an index signature for the rest so unknown event shapes still
 * parse.
 */
export interface RunEvent {
  readonly type: string;
  readonly subtype?: string;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly [key: string]: unknown;
}

export interface ProviderAdapter {
  containerCmd(opts: { prompt: string; model: string }): string[];
  parseEvents(stdout: Readable): AsyncIterable<RunEvent>;
  extractOutcome(events: RunEvent[]): string;
  extractCost(events: RunEvent[]): { usd: number; tokensIn: number; tokensOut: number } | null;
  models(): Promise<Model[]>;
}

import { ClaudeAdapter } from "./claude.js";
import { AntigravityAdapter } from "./antigravity.js";

const ADAPTERS: Record<string, ProviderAdapter> = {
  claude: new ClaudeAdapter(),
  antigravity: new AntigravityAdapter(),
};

export function getAdapter(provider: string): ProviderAdapter {
  const adapter = ADAPTERS[provider.toLowerCase()];
  if (!adapter) {
    throw new Error(`unknown provider: ${provider}`);
  }
  return adapter;
}
