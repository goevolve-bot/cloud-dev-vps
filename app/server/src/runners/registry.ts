import { join } from "node:path";
import { RunnerClient } from "./client.js";
import { RunnerDiscovery } from "./discovery.js";

export type RunnerLifecycleState = "connected" | "disconnected";

export interface RunnerRegistryOptions {
  readonly runnersDir: string;
  readonly pollIntervalMs?: number;
}

/**
 * Tracks one reconnecting RunnerClient per project discovered under
 * `runnersDir`, so an API layer can report each project's runner state
 * (T12's "state reflected in an API field") without touching sockets itself.
 */
export class RunnerRegistry {
  private readonly clients = new Map<string, RunnerClient>();
  private readonly discovery: RunnerDiscovery;

  constructor(private readonly opts: RunnerRegistryOptions) {
    this.discovery = new RunnerDiscovery({
      runnersDir: opts.runnersDir,
      pollIntervalMs: opts.pollIntervalMs,
      onChange: (projects) => this.reconcile(projects),
    });
  }

  async start(): Promise<void> {
    await this.discovery.start();
  }

  stop(): void {
    this.discovery.stop();
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private reconcile(projects: ReadonlySet<string>): void {
    for (const name of projects) {
      if (!this.clients.has(name)) {
        const socketPath = join(this.opts.runnersDir, name, "control.sock");
        this.clients.set(name, new RunnerClient({ socketPath }));
      }
    }
    for (const [name, client] of this.clients) {
      if (!projects.has(name)) {
        client.close();
        this.clients.delete(name);
      }
    }
  }

  /** "disconnected" also covers a project pm has never seen a socket for. */
  state(project: string): RunnerLifecycleState {
    return this.clients.get(project)?.isConnected ? "connected" : "disconnected";
  }

  projects(): string[] {
    return [...this.clients.keys()].sort();
  }

  client(project: string): RunnerClient | undefined {
    return this.clients.get(project);
  }
}
