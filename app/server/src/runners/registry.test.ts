import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeRunnerServer } from "./fake-runner-server.js";
import { RunnerRegistry } from "./registry.js";
import { waitFor } from "./test-helpers.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pm-registry-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a project's runner state flips to connected once its socket comes up", () =>
  withTempDir(async (runnersDir) => {
    await mkdir(join(runnersDir, "demo"), { recursive: true });
    const socketPath = join(runnersDir, "demo", "control.sock");
    const { shutdown } = startFakeRunnerServer(socketPath);
    const registry = new RunnerRegistry({ runnersDir, pollIntervalMs: 20 });
    try {
      await registry.start();
      await waitFor(() => registry.state("demo") === "connected");
      assert.deepEqual(registry.projects(), ["demo"]);

      const result = await registry.client("demo")?.call("status", {});
      assert.equal((result as { project: string }).project, "demo");
    } finally {
      registry.stop();
      await shutdown();
    }
  }));

test("an unknown project reads as disconnected", () =>
  withTempDir(async (runnersDir) => {
    const registry = new RunnerRegistry({ runnersDir, pollIntervalMs: 20 });
    try {
      await registry.start();
      assert.equal(registry.state("ghost"), "disconnected");
      assert.deepEqual(registry.projects(), []);
    } finally {
      registry.stop();
    }
  }));

test("a project disappears from the registry once its socket goes away", () =>
  withTempDir(async (runnersDir) => {
    await mkdir(join(runnersDir, "demo"), { recursive: true });
    const socketPath = join(runnersDir, "demo", "control.sock");
    const { shutdown } = startFakeRunnerServer(socketPath);
    const registry = new RunnerRegistry({ runnersDir, pollIntervalMs: 20 });
    try {
      await registry.start();
      await waitFor(() => registry.projects().includes("demo"));

      // Node's unix-socket server unlinks its own socket file on close.
      await shutdown();
      await rmdir(join(runnersDir, "demo"));
      await waitFor(() => !registry.projects().includes("demo"));
      assert.equal(registry.state("demo"), "disconnected");
    } finally {
      registry.stop();
    }
  }));
