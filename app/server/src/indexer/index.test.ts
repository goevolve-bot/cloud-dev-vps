import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addComment,
  addRunOutcome,
  createTask,
  moveTaskStatus,
  writeTaskDescription,
} from "@pm/core";
import type Database from "better-sqlite3";
import { openDb } from "../db/connection.js";
import { migrateUp } from "../db/migrate.js";
import { rebuildIndex, reindexTask } from "./index.js";

interface Fixture {
  readonly db: Database.Database;
  readonly repoDir: string;
  readonly projectId: number;
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await mkdtemp(join(tmpdir(), "pm-indexer-test-"));
  const db = openDb(":memory:");
  try {
    migrateUp(db);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO projects (name, git_url, repo_dir, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "demo",
        "git@example.com:demo.git",
        repoDir,
        "stopped",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    await fn({ db, repoDir, projectId: Number(lastInsertRowid) });
  } finally {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  }
}

function pmDir(repoDir: string): string {
  return join(repoDir, ".pm");
}

test("rebuildIndex populates tasks, comments, and task_runs from a .pm/ fixture", () =>
  withFixture(async ({ db, repoDir, projectId }) => {
    const task = await createTask(pmDir(repoDir), {
      title: "Promo Codes",
      description: "Add a promo code field.",
    });
    await addComment(task, { author: "alice", body: "looks good" });
    await addRunOutcome(
      task,
      {
        phase: "implement",
        provider: "claude",
        model: "claude-sonnet-5",
        status: "succeeded",
        costUsd: 0.12,
        tokensIn: 500,
        tokensOut: 100,
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:01:00Z",
      },
      "Implemented the field.",
    );

    const stats = await rebuildIndex(db, { id: projectId, repoDir });
    assert.deepEqual(stats, { tasks: 1, comments: 1, runs: 1 });

    const taskRow = db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND task_num = ?")
      .get(projectId, task.id) as Record<string, unknown>;
    assert.equal(taskRow.title, "Promo Codes");
    assert.equal(taskRow.status, "todo");
    assert.equal(taskRow.slug, "promo-codes");

    const commentRow = db
      .prepare("SELECT * FROM comments WHERE project_id = ? AND task_num = ?")
      .get(projectId, task.id) as Record<string, unknown>;
    assert.equal(commentRow.author, "alice");
    assert.equal(commentRow.body, "looks good\n");

    const runRow = db
      .prepare("SELECT * FROM task_runs WHERE project_id = ? AND task_num = ?")
      .get(projectId, task.id) as Record<string, unknown>;
    assert.equal(runRow.status, "succeeded");
    assert.equal(runRow.cost_usd, 0.12);
  }));

test("rebuildIndex is idempotent: rerunning it does not duplicate rows", () =>
  withFixture(async ({ db, repoDir, projectId }) => {
    await createTask(pmDir(repoDir), { title: "A", description: "a" });
    await createTask(pmDir(repoDir), { title: "B", description: "b" });

    await rebuildIndex(db, { id: projectId, repoDir });
    await rebuildIndex(db, { id: projectId, repoDir });

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?")
      .get(projectId) as {
      n: number;
    };
    assert.equal(count.n, 2);
  }));

test("reindexTask picks up an edited description without touching other tasks", () =>
  withFixture(async ({ db, repoDir, projectId }) => {
    const dir = pmDir(repoDir);
    const task = await createTask(dir, { title: "Promo Codes", description: "v1" });
    const other = await createTask(dir, { title: "Other task", description: "untouched" });
    await rebuildIndex(db, { id: projectId, repoDir });

    await writeTaskDescription(task, "v2");
    const updated = await reindexTask(db, { id: projectId, repoDir }, task.id);
    assert.equal(updated, true);

    const row = db
      .prepare("SELECT description FROM tasks WHERE project_id = ? AND task_num = ?")
      .get(projectId, task.id) as { description: string };
    assert.equal(row.description, "v2\n");

    const otherRow = db
      .prepare("SELECT description FROM tasks WHERE project_id = ? AND task_num = ?")
      .get(projectId, other.id) as { description: string };
    assert.equal(otherRow.description, "untouched\n");
  }));

test("reindexTask picks up a new comment and a status move", () =>
  withFixture(async ({ db, repoDir, projectId }) => {
    const dir = pmDir(repoDir);
    const task = await createTask(dir, { title: "Promo Codes", description: "d" });
    await rebuildIndex(db, { id: projectId, repoDir });

    await addComment(task, { body: "a new comment" });
    await moveTaskStatus(dir, task, "in-progress");
    await reindexTask(db, { id: projectId, repoDir }, task.id);

    const taskRow = db
      .prepare("SELECT status FROM tasks WHERE project_id = ? AND task_num = ?")
      .get(projectId, task.id) as { status: string };
    assert.equal(taskRow.status, "in-progress");

    const commentCount = db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE project_id = ? AND task_num = ?")
      .get(projectId, task.id) as { n: number };
    assert.equal(commentCount.n, 1);
  }));

test("reindexTask removes the cached row once a task folder disappears", () =>
  withFixture(async ({ db, repoDir, projectId }) => {
    const dir = pmDir(repoDir);
    const task = await createTask(dir, { title: "Promo Codes", description: "d" });
    await rebuildIndex(db, { id: projectId, repoDir });

    await rm(task.dir, { recursive: true, force: true });
    const found = await reindexTask(db, { id: projectId, repoDir }, task.id);
    assert.equal(found, false);

    const row = db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND task_num = ?")
      .get(projectId, task.id);
    assert.equal(row, undefined);
  }));
