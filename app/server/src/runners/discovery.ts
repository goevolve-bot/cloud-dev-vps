import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface RunnerDiscoveryOptions {
  readonly runnersDir: string;
  readonly pollIntervalMs?: number;
  readonly onChange: (projects: ReadonlySet<string>) => void;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

async function scanProjects(runnersDir: string): Promise<Set<string>> {
  let entries: string[];
  try {
    entries = await readdir(runnersDir);
  } catch {
    return new Set();
  }
  const found = new Set<string>();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await stat(join(runnersDir, entry, "control.sock"));
        found.add(entry);
      } catch {
        // no socket yet, or the entry isn't a project directory — skip it
      }
    }),
  );
  return found;
}

/**
 * Watches `/srv/pm/runners/` for project sockets appearing and disappearing.
 * A directory-level fs.watch is a fast, best-effort trigger (it can't see a
 * socket file appear *inside* an already-known subdirectory on every
 * platform); polling is what actually guarantees a start/stop toggle is
 * noticed, so it stays on unconditionally.
 */
export class RunnerDiscovery {
  private known = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private stopped = false;

  constructor(private readonly opts: RunnerDiscoveryOptions) {}

  async start(): Promise<void> {
    await this.refresh();
    const interval = this.opts.pollIntervalMs ?? 5000;
    this.timer = setInterval(() => void this.refresh(), interval);
    this.timer.unref?.();
    try {
      this.watcher = watch(this.opts.runnersDir, () => void this.refresh());
    } catch {
      // runnersDir may not exist yet, or recursive project-socket changes
      // aren't visible to a non-recursive watch on this platform — polling
      // above is the source of truth either way.
    }
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    const current = await scanProjects(this.opts.runnersDir);
    if (!setsEqual(current, this.known)) {
      this.known = current;
      this.opts.onChange(current);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
  }
}
