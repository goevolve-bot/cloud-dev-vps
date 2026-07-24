import { Readable } from "node:stream";

export interface Model {
  readonly id: string;
  readonly name: string;
}

export type RunEvent = Record<string, any>;

export interface ProviderAdapter {
  containerCmd(opts: { prompt: string; model: string }): string[];
  parseEvents(stdout: Readable): AsyncIterable<RunEvent>;
  extractOutcome(events: RunEvent[]): string;
  extractCost(events: RunEvent[]): { usd: number; tokensIn: number; tokensOut: number } | null;
  models(): Promise<Model[]>;
}

import { ClaudeAdapter } from "./claude.js";

const ADAPTERS: Record<string, ProviderAdapter> = {
  claude: new ClaudeAdapter(),
};

export function getAdapter(provider: string): ProviderAdapter {
  const adapter = ADAPTERS[provider.toLowerCase()];
  if (!adapter) {
    throw new Error(`unknown provider: ${provider}`);
  }
  return adapter;
}
