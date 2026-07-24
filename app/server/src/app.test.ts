import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDb } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { RunnerRegistry } from "./runners/registry.js";

interface Fixture {
  readonly app: FastifyInstance;
  readonly repoDir: string;
}

async function withApp(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await mkdtemp(join(tmpdir(), "pm-app-test-"));
  const runnersDir = await mkdtemp(join(tmpdir(), "pm-app-runners-test-"));
  const db = openDb(":memory:");
  migrateUp(db);
  db.prepare(
    "INSERT INTO projects (name, git_url, repo_dir, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "demo",
    "git@example.com:demo.git",
    repoDir,
    "stopped",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  const runners = new RunnerRegistry({ runnersDir, pollIntervalMs: 1000 });
  await runners.start();
  const app = buildApp({ db, runners });
  try {
    await fn({ app, repoDir });
  } finally {
    await app.close();
    runners.stop();
    db.close();
    await rm(repoDir, { recursive: true, force: true });
    await rm(runnersDir, { recursive: true, force: true });
  }
}

async function createTaskViaApi(
  app: FastifyInstance,
  payload: { title: string; description: string; status?: string },
) {
  const response = await app.inject({ method: "POST", url: "/api/projects/demo/tasks", payload });
  return response.json();
}

test("GET /api/projects lists projects with a runner state field", () =>
  withApp(async ({ app }) => {
    const response = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].name, "demo");
    assert.equal(body.projects[0].runnerState, "disconnected");
  }));

test("GET /api/projects/:name 404s for an unknown project", () =>
  withApp(async ({ app }) => {
    const response = await app.inject({ method: "GET", url: "/api/projects/ghost" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "project_not_found");
  }));

test("creating a task writes it to .pm/ on disk and into the cache", () =>
  withApp(async ({ app, repoDir }) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/demo/tasks",
      payload: { title: "Promo Codes", description: "Add a promo code field." },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.task.id, 1);
    assert.equal(body.task.title, "Promo Codes");
    assert.equal(body.task.status, "todo");
    assert.equal(body.pushed, false); // no runner connected in this test

    const onDisk = await readFile(
      join(repoDir, ".pm", "tasks", "todo", "0001-promo-codes", "index.md"),
      "utf8",
    );
    assert.match(onDisk, /Add a promo code field\./);

    const list = await app.inject({ method: "GET", url: "/api/projects/demo/tasks" });
    assert.equal(list.json().tasks.length, 1);
  }));

test("creating a task rejects a missing title or description", () =>
  withApp(async ({ app }) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/demo/tasks",
      payload: { title: "Only a title" },
    });
    assert.equal(response.statusCode, 400);
  }));

test("PATCH updates the description and status, reflected in the cache", () =>
  withApp(async ({ app }) => {
    const created = await createTaskViaApi(app, { title: "A", description: "v1" });
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/demo/tasks/${created.task.id}`,
      payload: { description: "v2", status: "in-progress" },
    });
    assert.equal(patch.statusCode, 200);
    const body = patch.json();
    assert.equal(body.task.description.trim(), "v2");
    assert.equal(body.task.status, "in-progress");

    const list = await app.inject({ method: "GET", url: "/api/projects/demo/tasks" });
    assert.equal(list.json().tasks[0].status, "in-progress");
  }));

test("PATCH 404s for a task that doesn't exist", () =>
  withApp(async ({ app }) => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/projects/demo/tasks/999",
      payload: { description: "x" },
    });
    assert.equal(response.statusCode, 404);
  }));

test("adding a comment appears in the task detail view and the cache", () =>
  withApp(async ({ app }) => {
    const created = await createTaskViaApi(app, { title: "A", description: "v1" });
    const commentResponse = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${created.task.id}/comments`,
      payload: { author: "alice", body: "looks good" },
    });
    assert.equal(commentResponse.statusCode, 201);
    assert.equal(commentResponse.json().comments.length, 1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/demo/tasks/${created.task.id}`,
    });
    const detailBody = detail.json();
    assert.equal(detailBody.comments.length, 1);
    assert.equal(detailBody.comments[0].author, "alice");
  }));

test("comment routes 404 for an unknown project without touching disk", () =>
  withApp(async ({ app }) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/ghost/tasks/1/comments",
      payload: { body: "x" },
    });
    assert.equal(response.statusCode, 404);
  }));

test("uploading an attachment with an explicit filename writes it under the task folder", () =>
  withApp(async ({ app, repoDir }) => {
    const created = await createTaskViaApi(app, { title: "A", description: "d" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${created.task.id}/attachments?filename=screenshot.png`,
      headers: { "content-type": "image/png" },
      payload: png,
    });
    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().filename, "screenshot.png");

    const list = await app.inject({
      method: "GET",
      url: `/api/projects/demo/tasks/${created.task.id}/attachments`,
    });
    assert.deepEqual(list.json().attachments, ["screenshot.png"]);

    const onDisk = await readFile(
      join(repoDir, ".pm", "tasks", "todo", "0001-a", "attachments", "screenshot.png"),
    );
    assert.deepEqual(onDisk, png);

    const download = await app.inject({
      method: "GET",
      url: `/api/projects/demo/tasks/${created.task.id}/attachments/screenshot.png`,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "image/png");
    assert.deepEqual(download.rawPayload, png);
  }));

test("a clipboard paste with no filename gets a pasted-NN name from its content type", () =>
  withApp(async ({ app }) => {
    const created = await createTaskViaApi(app, { title: "A", description: "d" });

    const textPaste = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${created.task.id}/attachments`,
      headers: { "content-type": "text/plain" },
      payload: "a".repeat(2000),
    });
    assert.equal(textPaste.statusCode, 201);
    assert.equal(textPaste.json().filename, "pasted-0001.md");

    const imagePaste = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${created.task.id}/attachments`,
      headers: { "content-type": "image/png" },
      payload: Buffer.from([1, 2, 3]),
    });
    assert.equal(imagePaste.statusCode, 201);
    // Numbering is scoped per extension, so the first .png paste is 0001
    // even though a .md paste already exists.
    assert.equal(imagePaste.json().filename, "pasted-0001.png");
  }));

test("attachment uploads reject a path-traversal filename", () =>
  withApp(async ({ app }) => {
    const created = await createTaskViaApi(app, { title: "A", description: "d" });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${created.task.id}/attachments?filename=${encodeURIComponent("../../evil")}`,
      headers: { "content-type": "text/plain" },
      payload: "x",
    });
    assert.equal(response.statusCode, 400);
  }));

test("attachment routes 404 for an unknown task", () =>
  withApp(async ({ app }) => {
    const list = await app.inject({
      method: "GET",
      url: "/api/projects/demo/tasks/999/attachments",
    });
    assert.equal(list.statusCode, 404);

    const download = await app.inject({
      method: "GET",
      url: "/api/projects/demo/tasks/999/attachments/x.png",
    });
    assert.equal(download.statusCode, 404);
  }));
