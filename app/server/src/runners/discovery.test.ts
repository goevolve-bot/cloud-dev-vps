import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunnerDiscovery } from "./discovery.js";
import { waitFor } from "./test-helpers.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pm-discovery-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("discovery finds a project whose control.sock already exists", () =>
  withTempDir(async (runnersDir) => {
    await mkdir(join(runnersDir, "demo"), { recursive: true });
    await writeFile(join(runnersDir, "demo", "control.sock"), "");

    const seen: Set<string>[] = [];
    const discovery = new RunnerDiscovery({
      runnersDir,
      pollIntervalMs: 20,
      onChange: (projects) => seen.push(new Set(projects)),
    });
    try {
      await discovery.start();
      assert.deepEqual([...seen[0]], ["demo"]);
    } finally {
      discovery.stop();
    }
  }));

test("a project appears once its socket is created and disappears once it's removed", () =>
  withTempDir(async (runnersDir) => {
    let current = new Set<string>();
    const discovery = new RunnerDiscovery({
      runnersDir,
      pollIntervalMs: 20,
      onChange: (projects) => {
        current = new Set(projects);
      },
    });
    try {
      await discovery.start();
      assert.equal(current.size, 0);

      await mkdir(join(runnersDir, "demo"), { recursive: true });
      await writeFile(join(runnersDir, "demo", "control.sock"), "");
      await waitFor(() => current.has("demo"));

      await unlink(join(runnersDir, "demo", "control.sock"));
      await waitFor(() => !current.has("demo"));
    } finally {
      discovery.stop();
    }
  }));

test("a missing runnersDir reads as no projects instead of throwing", () =>
  withTempDir(async (dir) => {
    const runnersDir = join(dir, "does-not-exist");
    let current: Set<string> | null = null;
    const discovery = new RunnerDiscovery({
      runnersDir,
      pollIntervalMs: 20,
      onChange: (projects) => {
        current = new Set(projects);
      },
    });
    try {
      await discovery.start();
      assert.equal(current, null); // no change fired: empty matches the initial known-empty state
    } finally {
      discovery.stop();
    }
  }));
