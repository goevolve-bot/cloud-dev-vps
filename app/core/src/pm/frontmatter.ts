import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedFrontMatter<T> {
  readonly data: T;
  readonly body: string;
}

/** Splits a `---\nyaml\n---\nbody` document. A missing/malformed header yields empty data. */
export function parseFrontMatter<T = Record<string, unknown>>(raw: string): ParsedFrontMatter<T> {
  const match = FRONT_MATTER_RE.exec(raw);
  if (!match) {
    return { data: {} as T, body: raw };
  }
  const [, yamlBlock, body] = match;
  const data = (parseYaml(yamlBlock) ?? {}) as T;
  return { data, body: body.replace(/^\n+/, "") };
}

export function stringifyFrontMatter(data: Record<string, unknown>, body: string): string {
  const yamlBlock = stringifyYaml(data).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return `---\n${yamlBlock}\n---\n\n${trimmedBody}\n`;
}
