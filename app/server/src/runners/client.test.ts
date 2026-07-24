import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunnerClient } from "./client.js";
import { startFakeRunnerServer } from "./fake-runner-server.js";
import { waitFor } from "./test-helpers.js";

/** Accepts connections but never writes a reply, and can drop them on
 * demand — for testing what happens to a call in flight when the runner
 * connection disappears out from under it. */
function startSilentServer(socketPath: string): {
  dropAll: () => void;
  shutdown: () => Promise<void>;
} {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  if (existsSync(socketPath)) unlinkSync(socketPath);
  server.listen(socketPath);
  return {
    dropAll: () => {
      for (const socket of sockets) socket.destroy();
    },
    shutdown: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pm-runner-client-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a client connects, calls a verb, and reports connected", () =>
  withTempDir(async (dir) => {
    const socketPath = join(dir, "control.sock");
    const { shutdown } = startFakeRunnerServer(socketPath);
    const client = new RunnerClient({ socketPath, reconnectDelayMs: 20 });
    try {
      await waitFor(() => client.isConnected);
      const result = await client.call("status", {});
      assert.equal((result as { project: string }).project, "demo");
    } finally {
      client.close();
      await shutdown();
    }
  }));

test("a call before the socket exists is rejected rather than hanging", () =>
  withTempDir(async (dir) => {
    const client = new RunnerClient({ socketPath: join(dir, "nope.sock"), reconnectDelayMs: 20 });
    try {
      await assert.rejects(client.call("status", {}), /not connected/);
    } finally {
      client.close();
    }
  }));

test("the client reconnects and recovers after the server restarts", () =>
  withTempDir(async (dir) => {
    const socketPath = join(dir, "control.sock");
    let fake = startFakeRunnerServer(socketPath);
    const client = new RunnerClient({ socketPath, reconnectDelayMs: 20, maxReconnectDelayMs: 50 });
    try {
      await waitFor(() => client.isConnected);

      await fake.shutdown();
      await waitFor(() => !client.isConnected);

      fake = startFakeRunnerServer(socketPath);
      await waitFor(() => client.isConnected, 3000);
      const result = await client.call("status", {});
      assert.equal((result as { project: string }).project, "demo");
    } finally {
      client.close();
      await fake.shutdown();
    }
  }));

test("a pending call is rejected when the connection drops", () =>
  withTempDir(async (dir) => {
    const socketPath = join(dir, "control.sock");
    const { dropAll, shutdown } = startSilentServer(socketPath);
    const client = new RunnerClient({ socketPath, reconnectDelayMs: 20 });
    try {
      await waitFor(() => client.isConnected);
      // The silent server never answers; dropping the connection must still
      // settle the call instead of leaving the caller hanging forever.
      const pendingCall = client.call("stopRun", { runId: 1 });
      dropAll();
      await assert.rejects(pendingCall, /runner connection closed/);
    } finally {
      client.close();
      await shutdown();
    }
  }));
