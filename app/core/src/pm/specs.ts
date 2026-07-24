import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeReaddir } from "./fs-helpers.js";
import { specsDir } from "./paths.js";

export interface SpecRecord {
  /** File name without the `.md` extension. */
  readonly name: string;
  readonly body: string;
  readonly path: string;
}

export async function writeSpec(pmDir: string, name: string, body: string): Promise<SpecRecord> {
  const dir = specsDir(pmDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  const withTrailingNewline = body.endsWith("\n") ? body : `${body}\n`;
  await writeFile(path, withTrailingNewline, "utf8");
  return { name, body: withTrailingNewline, path };
}

export async function readSpec(pmDir: string, name: string): Promise<SpecRecord> {
  const path = join(specsDir(pmDir), `${name}.md`);
  const body = await readFile(path, "utf8");
  return { name, body, path };
}

export async function listSpecs(pmDir: string): Promise<SpecRecord[]> {
  const names = (await safeReaddir(specsDir(pmDir))).filter((name) => name.endsWith(".md")).sort();
  const specs: SpecRecord[] = [];
  for (const name of names) {
    specs.push(await readSpec(pmDir, name.slice(0, -".md".length)));
  }
  return specs;
}
