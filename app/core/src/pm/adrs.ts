import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter, stringifyFrontMatter } from "./frontmatter.js";
import { safeReaddir } from "./fs-helpers.js";
import { formatId, nextId } from "./ids.js";
import { adrsDir } from "./paths.js";
import { slugify } from "./slug.js";

export type AdrStatus = "accepted" | "superseded" | "abandoned";

interface AdrFrontMatter {
  id: number;
  title: string;
  status: AdrStatus;
  supersededBy: number | null;
}

export interface AdrRecord {
  readonly id: number;
  readonly title: string;
  readonly status: AdrStatus;
  readonly supersededBy: number | null;
  readonly body: string;
  readonly path: string;
}

export async function nextAdrId(pmDir: string): Promise<number> {
  return nextId(await safeReaddir(adrsDir(pmDir)));
}

export interface WriteAdrOptions {
  readonly id?: number;
  readonly title: string;
  readonly status?: AdrStatus;
  readonly supersededBy?: number | null;
  readonly body: string;
}

export async function writeAdr(pmDir: string, opts: WriteAdrOptions): Promise<AdrRecord> {
  const dir = adrsDir(pmDir);
  await mkdir(dir, { recursive: true });
  const id = opts.id ?? (await nextAdrId(pmDir));
  const slug = slugify(opts.title);
  const path = join(dir, `${formatId(id)}-${slug}.md`);
  const front: AdrFrontMatter = {
    id,
    title: opts.title,
    status: opts.status ?? "accepted",
    supersededBy: opts.supersededBy ?? null,
  };
  await writeFile(
    path,
    stringifyFrontMatter(front as unknown as Record<string, unknown>, opts.body),
    "utf8",
  );
  return { ...front, body: opts.body, path };
}

export async function readAdr(pmDir: string, fileName: string): Promise<AdrRecord> {
  const path = join(adrsDir(pmDir), fileName);
  const { data, body } = parseFrontMatter<AdrFrontMatter>(await readFile(path, "utf8"));
  return {
    id: data.id,
    title: data.title,
    status: data.status,
    supersededBy: data.supersededBy ?? null,
    body,
    path,
  };
}

export async function listAdrs(pmDir: string): Promise<AdrRecord[]> {
  const names = (await safeReaddir(adrsDir(pmDir))).filter((name) => name.endsWith(".md")).sort();
  const adrs: AdrRecord[] = [];
  for (const name of names) {
    adrs.push(await readAdr(pmDir, name));
  }
  return adrs;
}
