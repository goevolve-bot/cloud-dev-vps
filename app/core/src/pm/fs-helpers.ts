import { readdir } from "node:fs/promises";

/** Like readdir, but a missing directory reads as empty instead of throwing. */
export async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
