import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type Database from "better-sqlite3";
import type { RunnerEvent } from "@pm/core";
import { openDb } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { QueueManager } from "./queue.js";
import type { RunnerRegistry } from "./runners/registry.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function newDb(): Database.Database {
  const db = openDb(":memory:");
  migrateUp(db);
  return db;
}

function insertProject(db: Database.Database, name = "demo", repoDir = "/nonexistent"): number {
  const now = "2026-01-01T00:00:00Z";
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO projects (name, git_url, repo_dir, lifecycle, always_on, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)",
    )
    .run(name, `git@example.com:${name}.git`, repoDir, now, now);
  return Number(lastInsertRowid);
}

function queueRun(
  db: Database.Database,
  projectId: number,
  taskNum: number,
  phase = "implement",
): number {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO runs (project_id, task_num, phase, provider, model, prompt, status, created_at) VALUES (?, ?, ?, 'claude', 'model-x', '', 'queued', ?)",
    )
    .run(projectId, taskNum, phase, new Date().toISOString());
  return Number(lastInsertRowid);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One data directory for the whole file: a parked run can write its log path
// at any time, so PM_DATA_DIR must not be juggled per test.
let dataDir: string;
const previousDataDir = process.env.PM_DATA_DIR;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pm-queue-data-"));
  process.env.PM_DATA_DIR = dataDir;
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.PM_DATA_DIR;
  else process.env.PM_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * A registry whose runner is always up and answers with `client`. RunnerRegistry
 * is a class with private fields, so a plain test double can never satisfy it
 * structurally — the `unknown` round-trip is the standard way to hand a fake to
 * code that only calls its public `state`/`client` methods.
 */
function fakeRegistry(client: unknown): RunnerRegistry {
  return {
    state: () => "connected",
    client: () => client,
  } as unknown as RunnerRegistry;
}

interface RunStatusRow {
  readonly status: string;
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

test("a queued run is started exactly once, even while its executor is still awaiting", async () => {
  const db = newDb();
  try {
    const projectId = insertProject(db);
    const runId = queueRun(db, projectId, 1);

    const started: number[] = [];
    // Mirrors the real executor's first act: an await (activating the
    // project's runner) that happens before anything else. The row must
    // already be out of 'queued' by then or the loop starts it again.
    const queue = new QueueManager(db, fakeRegistry(null), {
      autoStart: true,
      execute: async (run) => {
        started.push(run.id);
        await sleep(80);
      },
    });

    queue.trigger();
    await sleep(60);

    assert.deepEqual(started, [runId]);
    assert.equal(
      (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as RunStatusRow).status,
      "running",
    );
    await sleep(60);
  } finally {
    db.close();
  }
});

test("two triggers cannot both claim the same queued run", async () => {
  const db = newDb();
  try {
    const projectId = insertProject(db);
    queueRun(db, projectId, 1);

    const started: number[] = [];
    const queue = new QueueManager(db, fakeRegistry(null), {
      autoStart: true,
      execute: async (run) => {
        started.push(run.id);
        await sleep(50);
      },
    });

    queue.trigger();
    queue.trigger();
    queue.trigger();
    await sleep(60);

    assert.equal(started.length, 1);
  } finally {
    db.close();
  }
});

test("init drains runs that were still queued at shutdown", async () => {
  const db = newDb();
  try {
    const projectId = insertProject(db);
    const interrupted = queueRun(db, projectId, 1);
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(interrupted);
    const stranded = queueRun(db, projectId, 2);

    const started: number[] = [];
    const queue = new QueueManager(db, fakeRegistry(null), {
      autoStart: true,
      execute: async (run) => {
        started.push(run.id);
        await sleep(30);
      },
    });

    queue.init();
    await sleep(40);

    assert.equal(
      (db.prepare("SELECT status FROM runs WHERE id = ?").get(interrupted) as RunStatusRow).status,
      "interrupted",
    );
    assert.deepEqual(started, [stranded]);
  } finally {
    db.close();
  }
});

test("the concurrency limit is configurable and holds runs back", async () => {
  const db = newDb();
  const previous = process.env.PM_MAX_CONCURRENT_RUNS;
  process.env.PM_MAX_CONCURRENT_RUNS = "1";
  try {
    const projectId = insertProject(db);
    queueRun(db, projectId, 1);
    queueRun(db, projectId, 2);

    const started: number[] = [];
    const queue = new QueueManager(db, fakeRegistry(null), {
      autoStart: true,
      execute: async (run) => {
        started.push(run.id);
        await sleep(120);
      },
    });

    queue.trigger();
    await sleep(60);
    assert.equal(started.length, 1);
  } finally {
    if (previous === undefined) delete process.env.PM_MAX_CONCURRENT_RUNS;
    else process.env.PM_MAX_CONCURRENT_RUNS = previous;
    db.close();
  }
});

test("two queued runs on the same task never run at once", async () => {
  const db = newDb();
  try {
    const projectId = insertProject(db);
    queueRun(db, projectId, 7);
    queueRun(db, projectId, 7);

    const started: number[] = [];
    const queue = new QueueManager(db, fakeRegistry(null), {
      autoStart: true,
      execute: async (run) => {
        started.push(run.id);
        await sleep(120);
      },
    });

    queue.trigger();
    await sleep(60);
    assert.equal(started.length, 1);
  } finally {
    db.close();
  }
});

// ─── Executing a run against a fake runner ───────────────────────────────────

interface FakeCallArgs {
  readonly runId?: number;
  readonly phase?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly timeoutMs?: number;
}

interface RunnerCall {
  readonly verb: string;
  readonly args: FakeCallArgs;
}

interface FakeRunnerOptions {
  readonly exitCode?: number | null;
  readonly logLines?: string[];
  /** Runs of these phases never finish — used to park follow-on runs. */
  readonly hangOnPhases?: string[];
}

function fakeRunnerClient(calls: RunnerCall[], opts: FakeRunnerOptions = {}) {
  const lines = opts.logLines ?? [
    JSON.stringify({ type: "result", subtype: "success", result: "All done." }),
  ];
  const hung = new Set<number>();
  return {
    call: async (
      verb: string,
      args: FakeCallArgs,
      onEvent?: (event: RunnerEvent) => Promise<void>,
    ) => {
      calls.push({ verb, args });
      if (verb === "startRun") {
        if (args.phase && opts.hangOnPhases?.includes(args.phase) && args.runId !== undefined) {
          hung.add(args.runId);
        }
        return { runId: args.runId, status: "running" };
      }
      if (verb === "streamLogs") {
        if (args.runId !== undefined && hung.has(args.runId)) return new Promise(() => {});
        for (const line of lines) {
          await onEvent?.({ type: "log", runId: args.runId ?? -1, line });
        }
        return { runId: args.runId, complete: true, exitCode: opts.exitCode ?? 0 };
      }
      if (verb === "commitAndPush") return { branch: args.branch, pushed: true, committed: true };
      if (verb === "diff") return { branch: args.branch, base: "main", diff: "", found: false };
      return {};
    },
  };
}

async function makeRepo(): Promise<{ dir: string; taskDir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pm-queue-repo-"));
  const taskDir = join(dir, ".pm", "tasks", "todo", "0001-demo");
  await mkdir(join(taskDir, "runs"), { recursive: true });
  await writeFile(
    join(taskDir, "index.md"),
    "---\nid: 1\ntitle: demo\ncreated: 2026-01-01T00:00:00Z\nbranch: null\n---\nDemo task",
    "utf8",
  );
  return { dir, taskDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

interface RunRow {
  readonly id: number;
  readonly status: string;
  readonly exit_code: number | null;
}

/** Runs the queue until `runId` reaches a terminal status. */
async function runToCompletion(db: Database.Database, queue: QueueManager, runId: number): Promise<RunRow> {
  queue.trigger();
  for (let i = 0; i < 200; i++) {
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow;
    if (row.status !== "queued" && row.status !== "running") return row;
    await sleep(10);
  }
  throw new Error(`run ${runId} never finished`);
}

test("an implement run carries pm's run id, pushes its branch, and queues verify", async () => {
  const repo = await makeRepo();
  const db = newDb();
  try {
    const projectId = insertProject(db, "demo", repo.dir);
    const runId = queueRun(db, projectId, 1, "implement");

    const calls: RunnerCall[] = [];
    // The verify run this implement run queues is parked, so it cannot race
    // the assertions below.
    const client = fakeRunnerClient(calls, { hangOnPhases: ["verify"] });
    const queue = new QueueManager(db, fakeRegistry(client), { autoStart: true });
    const row = await runToCompletion(db, queue, runId);
    queue.stop();

    assert.equal(row.status, "succeeded");
    assert.equal(row.exit_code, 0);

    // §3.3: pm owns run identity — the runner is told which id to use, and the
    // same id addresses the run for streaming.
    const start = calls.find((c) => c.verb === "startRun");
    assert.equal(start?.args.runId, runId);
    assert.equal(calls.find((c) => c.verb === "streamLogs")?.args.runId, runId);
    assert.ok((start?.args.timeoutMs ?? 0) > 0);

    // §3.1: the branch is committed and pushed, so the follow-on verify sees it.
    const branchPush = calls.filter((c) => c.verb === "commitAndPush").map((c) => c.args.branch);
    assert.ok(branchPush.includes(""), "metadata is pushed on the default branch");
    assert.ok(branchPush.includes("pm/task-1-demo"), "the task branch is pushed");

    // §3.11: the board follows along on its own.
    const task = db
      .prepare("SELECT status FROM tasks WHERE project_id = ? AND task_num = 1")
      .get(projectId) as RunStatusRow;
    assert.equal(task.status, "in-progress");

    const verify = db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND phase = 'verify'")
      .get(projectId) as RunRow | undefined;
    assert.ok(verify, "a verify run is queued after a successful implement run");

    // The branch has to be recorded by pm, not by the runner: `.pm/` is
    // pm-owned on the host and project users are never in the pm group, so
    // the runner's attempt failed with EACCES on every run and the task's
    // front matter kept saying `branch: null`.
    const onDisk = await readFile(
      join(repo.dir, ".pm", "tasks", "in-progress", "0001-demo", "index.md"),
      "utf8",
    );
    assert.match(onDisk, /^branch: pm\/task-1-demo$/m);
  } finally {
    // No db.close(): the queue polls it, and a stopped queue can still have
    // one parked run holding a reference.
    await repo.cleanup();
  }
});

test("a non-zero exit code fails the run even when the agent printed a success result", async () => {
  const repo = await makeRepo();
  const db = newDb();
  try {
    const projectId = insertProject(db, "demo", repo.dir);
    const runId = queueRun(db, projectId, 1, "implement");

    const calls: RunnerCall[] = [];
    const queue = new QueueManager(db, fakeRegistry(fakeRunnerClient(calls, { exitCode: 137 })), {
      autoStart: true,
    });
    const row = await runToCompletion(db, queue, runId);
    queue.stop();

    assert.equal(row.status, "failed");
    // The real exit code is recorded, not a synthetic 0/1.
    assert.equal(row.exit_code, 137);
    const verifyCount = (
      db.prepare("SELECT COUNT(*) AS c FROM runs WHERE phase = 'verify'").get() as { c: number }
    ).c;
    assert.equal(verifyCount, 0, "a failed implement run does not trigger verify");
  } finally {
    // No db.close(): the queue polls it, and a stopped queue can still have
    // one parked run holding a reference.
    await repo.cleanup();
  }
});

test("an agent that exits 0 without any JSON result still counts as a success", async () => {
  const repo = await makeRepo();
  const db = newDb();
  try {
    const projectId = insertProject(db, "demo", repo.dir);
    const runId = queueRun(db, projectId, 1, "plan");

    const client = fakeRunnerClient([], { exitCode: 0, logLines: ["plain text output"] });
    const queue = new QueueManager(db, fakeRegistry(client), { autoStart: true });
    const row = await runToCompletion(db, queue, runId);
    queue.stop();

    assert.equal(row.status, "succeeded");
    assert.equal(row.exit_code, 0);
  } finally {
    // No db.close(): the queue polls it, and a stopped queue can still have
    // one parked run holding a reference.
    await repo.cleanup();
  }
});

test("a successful verify run moves the task to ready for review, filed under pm's own run id", async () => {
  const repo = await makeRepo();
  const db = newDb();
  try {
    const projectId = insertProject(db, "demo", repo.dir);
    // A prior run on the same task bumps the runtime run id away from 1, so
    // this test actually distinguishes "the outcome file is numbered by
    // runs.id" from "numbered by the task's own next-in-sequence counter" —
    // on a fresh DB the two would coincide and the assertion would pass
    // either way.
    queueRun(db, projectId, 1, "plan");
    const runId = queueRun(db, projectId, 1, "verify");

    const queue = new QueueManager(db, fakeRegistry(fakeRunnerClient([])), { autoStart: true });
    await runToCompletion(db, queue, runId);
    queue.stop();

    const task = db
      .prepare("SELECT status FROM tasks WHERE project_id = ? AND task_num = 1")
      .get(projectId) as RunStatusRow;
    assert.equal(task.status, "ready-for-review");

    // The outcome file is numbered by pm's own runtime run id, not by the
    // task's own next-in-sequence counter — this is what lets the UI
    // correlate a repo-side run to its runtime run by identity instead of a
    // (phase, started_at) heuristic.
    const outcome = await readFile(
      join(
        repo.dir,
        ".pm",
        "tasks",
        "ready-for-review",
        "0001-demo",
        "runs",
        `${String(runId).padStart(4, "0")}.md`,
      ),
      "utf8",
    );
    assert.match(outcome, /phase: verify/);
  } finally {
    // No db.close(): the queue polls it, and a stopped queue can still have
    // one parked run holding a reference.
    await repo.cleanup();
  }
});
