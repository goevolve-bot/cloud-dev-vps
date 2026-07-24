import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { RunnerEvent, RunnerMessage, RunnerVerb, RunnerVerbs } from "@pm/core";

export interface RunnerClientOptions {
  readonly socketPath: string;
  /** Called whenever the connection transitions between up and down. */
  readonly onStateChange?: (connected: boolean) => void;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
}

interface Pending {
  readonly resolve: (data: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly onEvent?: (event: RunnerEvent) => void;
}

/**
 * A persistent, auto-reconnecting client for one project's runner control
 * socket. Requests are multiplexed by id so several calls can be in flight at
 * once; a dropped connection fails every pending call and keeps retrying with
 * exponential backoff until the socket comes back.
 */
export class RunnerClient {
  private socket: Socket | null = null;
  private buffer = "";
  private connected = false;
  private closed = false;
  private reconnectDelay: number;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: RunnerClientOptions) {
    this.reconnectDelay = opts.reconnectDelayMs ?? 500;
    this.connect();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private connect(): void {
    if (this.closed) return;
    const socket = createConnection(this.opts.socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.connected = true;
      this.reconnectDelay = this.opts.reconnectDelayMs ?? 500;
      this.opts.onStateChange?.(true);
    });
    socket.on("data", (chunk: string) => this.onData(chunk));
    // 'close' always follows 'error' for a socket, so reconnect logic lives
    // there alone rather than being duplicated across both events.
    socket.on("error", () => {});
    socket.on("close", () => {
      this.socket = null;
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.opts.onStateChange?.(false);
      this.failAllPending(new Error("runner connection closed"));
      this.scheduleReconnect();
    });
    this.socket = socket;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, this.opts.maxReconnectDelayMs ?? 10_000);
    const timer = setTimeout(() => this.connect(), delay);
    timer.unref?.();
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineAt = this.buffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      newlineAt = this.buffer.indexOf("\n");
      if (line.trim()) this.onMessage(JSON.parse(line) as RunnerMessage);
    }
  }

  private onMessage(message: RunnerMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      pending.onEvent?.(message.event);
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "result") {
      pending.resolve(message.data);
    } else {
      pending.reject(Object.assign(new Error(message.message), { code: message.code }));
    }
  }

  call<V extends RunnerVerb>(
    verb: V,
    args: RunnerVerbs[V]["args"],
    onEvent?: (event: RunnerEvent) => void,
  ): Promise<RunnerVerbs[V]["result"]> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error(`not connected to runner at ${this.opts.socketPath}`));
    }
    const id = randomUUID();
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, onEvent });
      socket.write(`${JSON.stringify({ id, verb, args })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.end();
    this.socket?.destroy();
    this.failAllPending(new Error("client closed"));
  }
}
