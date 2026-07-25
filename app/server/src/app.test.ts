import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildApp } from "./app.js";
import { openDb } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { RunnerRegistry } from "./runners/registry.js";

interface Fixture {
  readonly app: FastifyInstance;
  readonly repoDir: string;
  readonly db: Database.Database;
}

// ─── pm-projectctl stub ──────────────────────────────────────────────────────
// A real unix socket speaking the NDJSON protocol from app/scripts/pm-projectctl,
// so these tests exercise the actual client (progress framing, terminal event
// shapes, argument names) rather than a mocked-out call.

type StubArgs = Record<string, string | undefined>;

interface StubCall {
  readonly verb: string;
  readonly args: StubArgs;
}

type StubReply =
  | { readonly ok: true; readonly data?: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

type StubResponder = (
  verb: string,
  args: StubArgs,
  emit: (step: string, message: string) => void,
  callIndex: number,
) => StubReply;

interface ProjectctlStub {
  readonly calls: StubCall[];
  close(): Promise<void>;
}

async function startProjectctlStub(respond: StubResponder): Promise<ProjectctlStub> {
  const dir = await mkdtemp(join(tmpdir(), "pm-pctl-"));
  const socketPath = join(dir, "projectctl.sock");
  const calls: StubCall[] = [];

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineAt = buffer.indexOf("\n");
      if (newlineAt === -1) return;
      const request = JSON.parse(buffer.slice(0, newlineAt));
      buffer = "";
      const callIndex = calls.length;
      calls.push({ verb: request.verb, args: request.args });

      const write = (event: unknown) => socket.write(`${JSON.stringify(event)}\n`);
      const emit = (step: string, message: string) =>
        write({ type: "progress", step, message });
      const reply = respond(request.verb, request.args, emit, callIndex);
      if (reply.ok) write({ type: "result", ok: true, data: reply.data ?? {} });
      else write({ type: "error", code: reply.code, message: reply.message });
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.PM_PROJECTCTL_SOCK = socketPath;

  return {
    calls,
    close: async () => {
      delete process.env.PM_PROJECTCTL_SOCK;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

interface ProjectRow {
  readonly git_url: string;
  readonly repo_dir: string | null;
  readonly runner_socket: string | null;
  readonly lifecycle: string;
}

interface ProviderView {
  readonly id: string;
  readonly authType: string;
  readonly connected: boolean;
}

/** The union of every field POST /api/projects puts on an SSE frame. */
interface SseEvent {
  readonly type: string;
  readonly step?: string;
  readonly message?: string;
  readonly code?: string;
  readonly publicKey?: string;
  readonly project?: { name: string; gitUrl: string; repoDir: string | null };
  readonly warnings?: string[];
}

/** The stream's last frame — `ready`, `awaiting-key` or `error`. */
function terminalEvent(payload: string): SseEvent {
  const last = sseEvents(payload).at(-1);
  assert.ok(last, "the SSE stream ended without an event");
  return last;
}

/** Parses an SSE body into the JSON payload of each `data:` frame. */
function sseEvents(payload: string): SseEvent[] {
  return payload
    .split("\n\n")
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join(""),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
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
    await fn({ app, repoDir, db });
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

test("creating a task wakes an idled project rather than skipping the push", () =>
  withApp(async ({ app }) => {
    // The board is versioned with the code, so a task is a commit — but only
    // the runner has git, and an idled project has no runner. Before this,
    // every board write against an idle project returned pushed:false and the
    // board diverged from origin until some later run happened to commit it.
    const stub = await startProjectctlStub((verb) =>
      verb === "start"
        ? { ok: true, data: {} }
        : { ok: false, code: "unexpected_verb", message: verb },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/demo/tasks",
        payload: { title: "Woken", description: "Should try to wake the runner." },
      });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(
        stub.calls.map((c) => c.verb),
        ["start"],
      );
      assert.equal(stub.calls[0].args.name, "demo");
      // The stub has no runner socket to offer, so the push still cannot
      // happen — but the attempt is reported honestly rather than skipped.
      assert.equal(response.json().pushed, false);
    } finally {
      await stub.close();
    }
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

test("runs queue endpoints create, list, and stop queued runs", () =>
  withApp(async ({ app }) => {
    const created = await createTaskViaApi(app, { title: "Test task", description: "desc" });
    const taskNum = created.task.id;

    // Create a run
    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${taskNum}/runs`,
      payload: {
        phase: "implement",
        provider: "claude",
        model: "claude-3-5-sonnet-latest",
        prompt: "hello test",
      },
    });
    assert.equal(createRes.statusCode, 201);
    const run = createRes.json().run;
    assert.equal(run.status, "queued");
    assert.equal(run.prompt, "hello test");

    // List runs
    const listRes = await app.inject({
      method: "GET",
      url: `/api/projects/demo/tasks/${taskNum}/runs`,
    });
    assert.equal(listRes.statusCode, 200);
    const runsList = listRes.json().runs;
    assert.equal(runsList.length, 1);
    assert.equal(runsList[0].id, run.id);

    // Get task details to verify queueRuns is present
    const detailsRes = await app.inject({
      method: "GET",
      url: `/api/projects/demo/tasks/${taskNum}`,
    });
    assert.equal(detailsRes.statusCode, 200);
    const details = detailsRes.json();
    assert.equal(details.queueRuns.length, 1);
    assert.equal(details.queueRuns[0].id, run.id);

    // Stop / cancel the queued run
    const stopRes = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/stop`,
    });
    assert.equal(stopRes.statusCode, 200);
    assert.equal(stopRes.json().stopped, true);

    // Verify it is cancelled
    const listResAfter = await app.inject({
      method: "GET",
      url: `/api/projects/demo/tasks/${taskNum}/runs`,
    });
    assert.equal(listResAfter.json().runs[0].status, "cancelled");
  }));

test("POST /api/projects streams progress, inserts the row and indexes the tree", () =>
  withApp(async ({ app, db }) => {
    const newRepo = await mkdtemp(join(tmpdir(), "pm-newproj-"));
    const stub = await startProjectctlStub((verb, args, emit) => {
      assert.equal(verb, "create");
      emit("user", `creating user pm-${args.name}`);
      emit("clone", "cloning");
      return {
        ok: true,
        data: {
          status: "ready",
          name: args.name,
          user: `pm-${args.name}`,
          gitUrl: args.gitUrl,
          repoDir: newRepo,
          publicKey: "ssh-ed25519 AAAA...",
          runnerSocket: `/srv/pm/runners/${args.name}/control.sock`,
          warnings: [],
        },
      };
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "shop", gitUrl: "git@example.com:you/shop.git" },
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers["content-type"] as string, /text\/event-stream/);

      const events = sseEvents(response.payload);
      assert.deepEqual(
        events.filter((e) => e.type === "progress").map((e) => e.step),
        ["user", "clone", "credentials", "index"],
      );
      const terminal = terminalEvent(response.payload);
      assert.equal(terminal.type, "ready");
      assert.equal(terminal.project?.name, "shop");
      assert.equal(terminal.project?.gitUrl, "git@example.com:you/shop.git");
      assert.equal(terminal.project?.repoDir, newRepo);

      const row = db.prepare("SELECT * FROM projects WHERE name = 'shop'").get() as ProjectRow;
      assert.equal(row.git_url, "git@example.com:you/shop.git");
      assert.equal(row.runner_socket, "/srv/pm/runners/shop/control.sock");
      assert.equal(row.lifecycle, "active");

      const list = await app.inject({ method: "GET", url: "/api/projects" });
      assert.deepEqual(
        list.json().projects.map((p: { name: string }) => p.name),
        ["demo", "shop"],
      );
    } finally {
      await stub.close();
      await rm(newRepo, { recursive: true, force: true });
    }
  }));

test("POST /api/projects surfaces awaiting-key and resumes on a second POST", () =>
  withApp(async ({ app, db }) => {
    const newRepo = await mkdtemp(join(tmpdir(), "pm-newproj-"));
    const stub = await startProjectctlStub((verb, args, emit, callIndex) => {
      emit("key", "generating deploy key");
      if (callIndex === 0) {
        return {
          ok: true,
          data: {
            status: "awaiting-key",
            name: args.name,
            publicKey: "ssh-ed25519 AAAAdeploy",
            message: "Add the deploy key to the repository (write access).",
          },
        };
      }
      return {
        ok: true,
        data: { status: "ready", name: args.name, repoDir: newRepo, warnings: [] },
      };
    });

    try {
      const payload = { name: "shop", gitUrl: "git@example.com:you/shop.git" };

      const first = await app.inject({ method: "POST", url: "/api/projects", payload });
      assert.equal(first.statusCode, 200);
      const firstTerminal = terminalEvent(first.payload);
      assert.equal(firstTerminal.type, "awaiting-key");
      assert.equal(firstTerminal.publicKey, "ssh-ed25519 AAAAdeploy");
      // Nothing is inserted while the key is still unauthorized.
      assert.equal(db.prepare("SELECT * FROM projects WHERE name = 'shop'").get(), undefined);

      const second = await app.inject({ method: "POST", url: "/api/projects", payload });
      assert.equal(second.statusCode, 200);
      assert.equal(terminalEvent(second.payload).type, "ready");
      assert.ok(db.prepare("SELECT * FROM projects WHERE name = 'shop'").get());

      // Resuming must not be rejected as "already exists"…
      const third = await app.inject({ method: "POST", url: "/api/projects", payload });
      assert.equal(third.statusCode, 200);
      assert.equal(terminalEvent(third.payload).type, "ready");
      assert.equal(stub.calls.length, 3);
    } finally {
      await stub.close();
      await rm(newRepo, { recursive: true, force: true });
    }
  }));

test("POST /api/projects rejects a bad name and a name already bound to another URL", () =>
  withApp(async ({ app }) => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Not_A_Name", gitUrl: "git@example.com:you/x.git" },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "invalid_name");

    const conflict = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "demo", gitUrl: "git@example.com:someone/else.git" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, "project_exists");
  }));

test("POST /api/projects reports a projectctl failure as an error event", () =>
  withApp(async ({ app, db }) => {
    const stub = await startProjectctlStub(() => ({
      ok: false,
      code: "invalid_url",
      message: "git URL must be https://, ssh:// or user@host:path",
    }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "shop", gitUrl: "ext::sh -c evil" },
      });
      const terminal = terminalEvent(response.payload);
      assert.equal(terminal.type, "error");
      assert.equal(terminal.code, "invalid_url");
      assert.equal(db.prepare("SELECT * FROM projects WHERE name = 'shop'").get(), undefined);
    } finally {
      await stub.close();
    }
  }));

test("connecting a provider fans the key out to every project user", () =>
  withApp(async ({ app, db }) => {
    const stub = await startProjectctlStub(() => ({ ok: true, data: { written: true } }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/providers/claude/connect",
        payload: { type: "api-key", key: "sk-ant-secret-value" },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
      assert.equal(response.json().projectsUpdated, 1);

      // The exact argument names verb_set_credential validates: `key` (not
      // `credential`), a real project name (not `_pm`), lowercase key name.
      assert.equal(stub.calls.length, 1);
      assert.deepEqual(stub.calls[0], {
        verb: "set-credential",
        args: { name: "demo", key: "anthropic", value: "sk-ant-secret-value" },
      });

      const cred = db
        .prepare("SELECT * FROM provider_creds WHERE provider = 'claude'")
        .get() as { secret: string; masked_key: string };
      assert.equal(cred.secret, "sk-ant-secret-value");
      assert.match(cred.masked_key, /^sk-a\*+alue$/);

      const providers = (await app.inject({ method: "GET", url: "/api/providers" })).json()
        .providers;
      assert.equal(providers.find((p: ProviderView) => p.id === "claude")?.connected, true);
      // No OAuth flow exists, so no provider may claim one.
      assert.deepEqual(
        providers.map((p: ProviderView) => p.authType),
        ["api-key", "api-key"],
      );
    } finally {
      await stub.close();
    }
  }));

test("a failed set-credential is reported instead of being recorded as connected", () =>
  withApp(async ({ app, db }) => {
    const stub = await startProjectctlStub(() => ({
      ok: false,
      code: "unknown_project",
      message: "project 'demo' does not exist",
    }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/providers/claude/connect",
        payload: { type: "api-key", key: "sk-ant-secret-value" },
      });
      assert.equal(response.statusCode, 502);
      const body = response.json();
      assert.equal(body.ok, false);
      assert.equal(body.failures[0].project, "demo");
      assert.match(body.failures[0].message, /does not exist/);

      // The old code wrote the masked row regardless and the UI said
      // "Connected" while ~/.pm-creds stayed empty.
      assert.equal(db.prepare("SELECT * FROM provider_creds").get(), undefined);
      const providers = (await app.inject({ method: "GET", url: "/api/providers" })).json()
        .providers;
      assert.equal(providers.find((p: ProviderView) => p.id === "claude")?.connected, false);
    } finally {
      await stub.close();
    }
  }));

test("a project created after the key was entered is seeded with it", () =>
  withApp(async ({ app, db }) => {
    const newRepo = await mkdtemp(join(tmpdir(), "pm-newproj-"));
    const stub = await startProjectctlStub((verb, args) => {
      if (verb === "create") {
        return { ok: true, data: { status: "ready", name: args.name, repoDir: newRepo } };
      }
      return { ok: true, data: { written: true } };
    });
    try {
      await app.inject({
        method: "POST",
        url: "/api/providers/claude/connect",
        payload: { type: "api-key", key: "sk-ant-secret-value" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "shop", gitUrl: "git@example.com:you/shop.git" },
      });
      assert.equal(terminalEvent(response.payload).type, "ready");

      const seeded = stub.calls.filter(
        (call) => call.verb === "set-credential" && call.args.name === "shop",
      );
      assert.deepEqual(seeded.map((call) => call.args.key), ["anthropic"]);
      assert.equal(seeded[0].args.value, "sk-ant-secret-value");
      assert.ok(db.prepare("SELECT * FROM projects WHERE name = 'shop'").get());
    } finally {
      await stub.close();
      await rm(newRepo, { recursive: true, force: true });
    }
  }));

test("connect rejects an unknown provider and a non-key auth type", () =>
  withApp(async ({ app }) => {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/providers/gpt/connect",
      payload: { type: "api-key", key: "x" },
    });
    assert.equal(unknown.statusCode, 404);

    const wrongType = await app.inject({
      method: "POST",
      url: "/api/providers/claude/connect",
      payload: { type: "oauth" },
    });
    assert.equal(wrongType.statusCode, 400);
  }));

test("answering a question requires the right project and task", () =>
  withApp(async ({ app, db }) => {
    const created = await createTaskViaApi(app, { title: "Auth", description: "d" });
    const taskNum = created.task.id;
    db.prepare(
      "INSERT INTO runs (id, project_id, task_num, phase, provider, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(202, 1, taskNum, "interview", "claude", "claude-3-5", "succeeded", "2026-01-01T00:00:00Z");
    const questionId = db
      .prepare("INSERT INTO questions (project_id, task_num, run_id, text) VALUES (?, ?, ?, ?)")
      .run(1, taskNum, 202, "Which auth?").lastInsertRowid;

    const wrongProject = await app.inject({
      method: "POST",
      url: `/api/projects/ghost/tasks/${taskNum}/questions/${questionId}/answer`,
      payload: { answer: "x" },
    });
    assert.equal(wrongProject.statusCode, 404);

    const wrongTask = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/999/questions/${questionId}/answer`,
      payload: { answer: "x" },
    });
    assert.equal(wrongTask.statusCode, 404);

    const ok = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${taskNum}/questions/${questionId}/answer`,
      payload: { answer: "JWT" },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().question.answer, "JWT");
  }));

test("answering questions and retrieving specs/ADRs", () =>
  withApp(async ({ app, repoDir, db }) => {
    const created = await createTaskViaApi(app, { title: "Auth Task", description: "basic auth" });
    const taskNum = created.task.id;

    // Insert mock run and question
    db.prepare(
      "INSERT INTO runs (id, project_id, task_num, phase, provider, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(101, 1, taskNum, "interview", "claude", "claude-3-5", "succeeded", "2026-01-01T00:00:00Z");

    const questionResult = db.prepare(
      "INSERT INTO questions (project_id, task_num, run_id, text) VALUES (?, ?, ?, ?)"
    ).run(1, taskNum, 101, "Should we use JWT?");
    const questionId = questionResult.lastInsertRowid;

    // Answer the question
    const answerRes = await app.inject({
      method: "POST",
      url: `/api/projects/demo/tasks/${taskNum}/questions/${questionId}/answer`,
      payload: { answer: "Yes, use JWT" },
    });
    assert.equal(answerRes.statusCode, 200);
    assert.equal(answerRes.json().question.answer, "Yes, use JWT");

    // Fetch task detail and verify questions are present
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/projects/demo/tasks/${taskNum}`,
    });
    assert.equal(detailRes.statusCode, 200);
    const detail = detailRes.json();
    assert.equal(detail.questions.length, 1);
    assert.equal(detail.questions[0].text, "Should we use JWT?");
    assert.equal(detail.questions[0].answer, "Yes, use JWT");

    // Write mock specs and ADRs
    const specsDir = join(repoDir, ".pm", "specs");
    const adrsDir = join(repoDir, ".pm", "adrs");
    await mkdir(specsDir, { recursive: true });
    await mkdir(adrsDir, { recursive: true });

    await writeFile(join(specsDir, "auth.md"), "# Auth Spec\nJWT details.\n");
    await writeFile(
      join(adrsDir, "0001-setup.md"),
      "---\nid: 1\ntitle: Setup Auth\nstatus: accepted\nsupersededBy: null\n---\n# Setup Auth\n"
    );

    // Fetch specs list
    const specsRes = await app.inject({
      method: "GET",
      url: "/api/projects/demo/specs",
    });
    assert.equal(specsRes.statusCode, 200);
    assert.equal(specsRes.json().specs.length, 1);
    assert.equal(specsRes.json().specs[0].name, "auth");
    assert.match(specsRes.json().specs[0].body, /JWT details/);

    // Fetch ADRs list
    const adrsRes = await app.inject({
      method: "GET",
      url: "/api/projects/demo/adrs",
    });
    assert.equal(adrsRes.statusCode, 200);
    assert.equal(adrsRes.json().adrs.length, 1);
    assert.equal(adrsRes.json().adrs[0].id, 1);
    assert.equal(adrsRes.json().adrs[0].title, "Setup Auth");
    assert.match(adrsRes.json().adrs[0].body, /Setup Auth/);
  }));

