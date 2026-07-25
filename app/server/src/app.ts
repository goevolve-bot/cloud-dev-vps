import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addComment,
  createTask,
  findTask,
  getAdapter,
  isTaskStatus,
  listAttachments,
  moveTaskStatus,
  nextPastedName,
  pmDirFor,
  readAttachment,
  writeAttachment,
  writeTaskDescription,
  listSpecs,
  listAdrs,
  type TaskStatus,
} from "@pm/core";
import { rebuildIndex, reindexTask } from "./indexer/index.js";
import type { RunnerRegistry } from "./runners/registry.js";
import { QueueManager, ensureRunnerConnected, sseEmitter } from "./queue.js";
import { callProjectctl } from "./projectctl.js";

export interface AppContext {
  readonly db: Database.Database;
  readonly runners: RunnerRegistry;
}

interface ProjectRow {
  readonly id: number;
  readonly name: string;
  readonly git_url: string;
  readonly repo_dir: string | null;
  readonly default_provider: string | null;
  readonly default_model: string | null;
  readonly contract_json: string | null;
  readonly lifecycle: string;
  readonly always_on: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TaskRow {
  readonly task_num: number;
  readonly slug: string;
  readonly status: string;
  readonly title: string;
  readonly description: string;
  readonly branch: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RunRow {
  readonly id: number;
  readonly project_id: number;
  readonly task_num: number;
  readonly phase: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string | null;
  readonly status: string;
  readonly exit_code: number | null;
  readonly log_path: string | null;
  readonly artifacts_dir: string | null;
  readonly cost_usd: number | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

function serializeProject(row: ProjectRow, runnerState: string) {
  let contract = null;
  if (row.contract_json) {
    try {
      contract = JSON.parse(row.contract_json);
    } catch {
      // ignore
    }
  }
  return {
    id: row.id,
    name: row.name,
    gitUrl: row.git_url,
    repoDir: row.repo_dir,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    contract,
    lifecycle: row.lifecycle,
    alwaysOn: Boolean(row.always_on),
    runnerState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeTask(row: TaskRow) {
  return {
    id: row.task_num,
    slug: row.slug,
    status: row.status,
    title: row.title,
    description: row.description,
    branch: row.branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  md: "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
};

function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

function extFor(mimeType: string): string {
  const found = Object.entries(EXT_TO_MIME).find(([, mime]) => mime === mimeType);
  return found?.[0] ?? "bin";
}

/** A short window of `text` around the first case-insensitive match of `needle`. */
function snippetAround(text: string, needle: string, radius = 60): string {
  const idx = text.toLowerCase().indexOf(needle);
  if (idx === -1) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

interface SearchResult {
  readonly type: "task" | "spec" | "adr";
  readonly title: string;
  readonly snippet: string;
  readonly taskNum?: number;
}

// Mirrors pm-projectctl's NAME_RE. Checking here too means a bad name is a
// 400 with a useful message rather than an `invalid_name` error arriving
// halfway through an SSE stream.
const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,27}[a-z0-9])?$/;

/**
 * Provider id → the file name written into each project user's ~/.pm-creds/.
 *
 * Constrained on both ends: pm-projectctl's CREDENTIAL_KEY_RE demands
 * `^[a-z][a-z0-9_-]{0,63}$` (which is why this is not the env var name), and
 * the runner maps these exact file names onto environment variables inside
 * the agent container — see CREDENTIAL_ENV in runner/src/handlers.ts. Adding a
 * provider means adding it in both places.
 */
const PROVIDER_CREDENTIAL_KEYS: Record<string, string> = {
  claude: "anthropic",
  antigravity: "antigravity",
};

function maskKey(key: string): string {
  return key.length > 8
    ? `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`
    : "****";
}

// A single path segment, no separators — closes off traversal outside the
// task's attachments/ directory regardless of what @pm/core does with it.
const SAFE_FILENAME_RE = /^[^/\\]+$/;

function isSafeFilename(name: string): boolean {
  return SAFE_FILENAME_RE.test(name) && name !== "." && name !== ".." && !name.includes("\0");
}

// runNum is interpolated straight into a filesystem path (verify-artifacts/<runNum>
// and PM_DATA_DIR/artifacts/<runNum>); it must be digits only or a request like
// runNum=../../.. reads/lists arbitrary paths reachable by the pm user.
const RUN_NUM_RE = /^\d+$/;

function isSafeRunNum(runNum: string): boolean {
  return RUN_NUM_RE.test(runNum);
}

/**
 * Where the built SPA lives. In the server image (server/Dockerfile) the
 * workspace is laid out at /repo, this module compiles to /repo/server/dist/,
 * and vite writes /repo/web/dist — hence two levels up. Running the server
 * straight from a source checkout gives the same relative answer.
 */
function resolveWebRoot(): string {
  if (process.env.PM_WEB_DIR) return process.env.PM_WEB_DIR;
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

/**
 * Adopt projects that exist on the host but not in pm's DB.
 *
 * POST /api/projects is the authoritative path and inserts its own row; this
 * only catches projects provisioned out of band — `pm-projectctl create` run
 * over SSH, or a DB restored from before B2. Discovery gives us a name;
 * `status` gives us the git URL and repo dir that the row actually needs, and
 * a project it cannot answer for is skipped rather than half-inserted.
 */
export async function reconcileDiscoveredProjects(ctx: AppContext): Promise<string[]> {
  const { db, runners } = ctx;
  const adopted: string[] = [];

  for (const name of runners.projects()) {
    const known = db.prepare("SELECT id FROM projects WHERE name = ?").get(name);
    if (known) continue;

    const result = await callProjectctl("status", { name });
    const entries = (result.data?.projects ?? []) as {
      gitUrl?: string;
      repoDir?: string;
      runnerSocket?: string;
    }[];
    const entry = entries[0];
    if (!result.ok || !entry?.gitUrl) {
      console.warn(`[reconcile] skipping ${name}: ${result.message ?? "no status from projectctl"}`);
      continue;
    }

    const now = new Date().toISOString();
    const insert = db
      .prepare(
        "INSERT INTO projects (name, git_url, repo_dir, runner_socket, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      )
      .run(name, entry.gitUrl, entry.repoDir ?? null, entry.runnerSocket ?? null, now, now);

    if (entry.repoDir) {
      try {
        await rebuildIndex(db, { id: Number(insert.lastInsertRowid), repoDir: entry.repoDir });
      } catch (err) {
        console.warn(`[reconcile] indexing ${name} failed:`, err);
      }
    }
    adopted.push(name);
  }

  return adopted;
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db, runners } = ctx;

  const queueManager = new QueueManager(db, runners);
  queueManager.init();

  // application/json and text/plain already have built-in parsers; this is
  // the fallback for attachment uploads (images, arbitrary files).
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  function getProjectRow(name: string): ProjectRow | undefined {
    return db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRow | undefined;
  }

  function getProjectById(id: number): ProjectRow | undefined {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  function getTaskRow(projectId: number, taskNum: number): TaskRow | undefined {
    return db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND task_num = ?")
      .get(projectId, taskNum) as TaskRow | undefined;
  }

  /**
   * .pm/ writes commit on the runner's pinned default-branch checkout, not a
   * task branch — the exact branch-name contract for that call is T22's job.
   * Best-effort in the sense that a task/comment always lands on disk and in
   * the cache even if the push cannot happen; it is *not* best-effort about
   * trying. A project that has idled out has no runner, and the runner is the
   * only thing on the host that has git, so without waking it first every
   * board write made against an idle project returned `pushed: false` and the
   * board silently diverged from origin until some later run happened to
   * commit it. Waking costs a cold start on the first write; the project is
   * already active for every write after it.
   */
  async function commitAndPushBestEffort(projectName: string): Promise<boolean> {
    if (!(await ensureRunnerConnected(runners, projectName))) return false;
    const client = runners.client(projectName);
    if (!client) return false;
    try {
      await client.call("commitAndPush", { branch: "" });
      return true;
    } catch {
      return false;
    }
  }

  interface CredentialSeed {
    readonly provider: string;
    readonly key: string;
    readonly value: string;
  }

  /** Every provider key pm currently holds, in ~/.pm-creds file-name form. */
  function storedCredentials(): CredentialSeed[] {
    const rows = db
      .prepare("SELECT provider, secret FROM provider_creds WHERE secret IS NOT NULL")
      .all() as { provider: string; secret: string }[];
    return rows
      .map((row) => ({
        provider: row.provider,
        key: PROVIDER_CREDENTIAL_KEYS[row.provider] ?? "",
        value: row.secret,
      }))
      .filter((seed) => seed.key !== "");
  }

  interface DeliveryResult {
    readonly project: string;
    readonly key: string;
    readonly ok: boolean;
    readonly message?: string;
  }

  async function deliverCredential(
    projectName: string,
    seed: CredentialSeed,
  ): Promise<DeliveryResult> {
    const result = await callProjectctl("set-credential", {
      name: projectName,
      key: seed.key,
      value: seed.value,
    });
    return {
      project: projectName,
      key: seed.key,
      ok: Boolean(result.ok),
      message: result.ok ? undefined : (result.message ?? result.code ?? "unknown error"),
    };
  }

  /** Re-seed a freshly created project with the keys entered before it existed. */
  async function seedCredentialsInto(projectName: string): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    for (const seed of storedCredentials()) {
      results.push(await deliverCredential(projectName, seed));
    }
    return results;
  }

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/projects", async () => {
    const rows = db.prepare("SELECT * FROM projects ORDER BY name").all() as ProjectRow[];
    return { projects: rows.map((row) => serializeProject(row, runners.state(row.name))) };
  });

  /**
   * Create a project, streaming progress as SSE.
   *
   * `create` provisions a user, rootless docker, a deploy key and a clone — it
   * takes minutes, so a plain request/response would look hung. The stream
   * carries `progress`, then exactly one of `awaiting-key`, `ready` or
   * `error`, then closes.
   *
   * `awaiting-key` is a success, not a failure: the deploy key exists but the
   * repo has not authorized it yet. The client shows the key and POSTs the
   * same body again once the user has added it; `create` is idempotent and
   * resumes from the clone step.
   */
  app.post("/api/projects", async (request, reply) => {
    const body = request.body as { name?: string; gitUrl?: string } | undefined;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const gitUrl = typeof body?.gitUrl === "string" ? body.gitUrl.trim() : "";

    if (!PROJECT_NAME_RE.test(name)) {
      return reply.code(400).send({
        error: "invalid_name",
        message:
          "project name must be lowercase [a-z0-9-], start and end alphanumeric, max 29 characters",
      });
    }
    if (!gitUrl) {
      return reply.code(400).send({ error: "git_url_required" });
    }

    // A repeat POST for the same project is the documented resume path, so
    // only a *different* URL for a name we already track is a conflict.
    const existing = getProjectRow(name);
    if (existing && existing.git_url !== gitUrl) {
      return reply
        .code(409)
        .send({ error: "project_exists", message: `${name} already tracks ${existing.git_url}` });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const result = await callProjectctl("create", { name, gitUrl }, (progress) =>
      send({ type: "progress", step: progress.step, message: progress.message }),
    );

    if (!result.ok) {
      send({ type: "error", code: result.code ?? "projectctl_failed", message: result.message });
      reply.raw.end();
      return;
    }

    const data = (result.data ?? {}) as {
      status?: string;
      publicKey?: string;
      message?: string;
      repoDir?: string;
      runnerSocket?: string;
      warnings?: string[];
    };

    if (data.status === "awaiting-key") {
      send({
        type: "awaiting-key",
        publicKey: data.publicKey,
        message: data.message,
      });
      reply.raw.end();
      return;
    }

    const now = new Date().toISOString();
    if (existing) {
      db.prepare(
        "UPDATE projects SET git_url = ?, repo_dir = ?, runner_socket = ?, lifecycle = 'active', updated_at = ? WHERE id = ?",
      ).run(gitUrl, data.repoDir ?? null, data.runnerSocket ?? null, now, existing.id);
    } else {
      db.prepare(
        "INSERT INTO projects (name, git_url, repo_dir, runner_socket, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      ).run(name, gitUrl, data.repoDir ?? null, data.runnerSocket ?? null, now, now);
    }
    const row = getProjectRow(name)!;

    const warnings = [...(data.warnings ?? [])];

    // The key may have been entered before this project existed; §2.2's
    // fan-out could not have reached it, so seed it now.
    send({ type: "progress", step: "credentials", message: "seeding provider credentials" });
    for (const delivery of await seedCredentialsInto(name)) {
      if (!delivery.ok) {
        warnings.push(`credential ${delivery.key} was not written: ${delivery.message}`);
      }
    }

    if (row.repo_dir) {
      send({ type: "progress", step: "index", message: "indexing .pm/ tree" });
      try {
        await rebuildIndex(db, { id: row.id, repoDir: row.repo_dir });
      } catch (err) {
        warnings.push(`indexing failed: ${String(err)}`);
      }
    }

    send({
      type: "ready",
      project: serializeProject(getProjectRow(name)!, runners.state(name)),
      publicKey: data.publicKey,
      warnings,
    });
    reply.raw.end();
  });

  app.get("/api/projects/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    return serializeProject(project, runners.state(project.name));
  });

  app.get("/api/projects/:name/tasks", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    const rows = db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY status, task_num")
      .all(project.id) as TaskRow[];
    return { tasks: rows.map(serializeTask) };
  });

  app.get("/api/projects/:name/tasks/:taskNum", async (request, reply) => {
    const { name, taskNum } = request.params as { name: string; taskNum: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    const num = Number(taskNum);
    const task = getTaskRow(project.id, num);
    if (!task) return reply.code(404).send({ error: "task_not_found" });
    const comments = db
      .prepare("SELECT * FROM comments WHERE project_id = ? AND task_num = ? ORDER BY comment_num")
      .all(project.id, num);
    const runs = db
      .prepare("SELECT * FROM task_runs WHERE project_id = ? AND task_num = ? ORDER BY run_num")
      .all(project.id, num);
    const queueRuns = db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND task_num = ? ORDER BY id")
      .all(project.id, num);
    const questions = db
      .prepare("SELECT * FROM questions WHERE project_id = ? AND task_num = ? ORDER BY id")
      .all(project.id, num);
    
    let plan = null;
    if (project.repo_dir) {
      try {
        const pmDir = pmDirFor(project.repo_dir);
        const taskRecord = await findTask(pmDir, num);
        if (taskRecord) {
          plan = readFileSync(join(taskRecord.dir, "plan.md"), "utf8");
        }
      } catch {
        // ignore
      }
    }
    return { task: serializeTask(task), comments, runs, queueRuns, questions, plan };
  });

  // Scoped to its project and task like every neighbouring route: a question
  // id alone must not be enough to answer it.
  app.post(
    "/api/projects/:name/tasks/:taskNum/questions/:id/answer",
    async (request, reply) => {
      const { name, taskNum, id } = request.params as {
        name: string;
        taskNum: string;
        id: string;
      };
      const project = getProjectRow(name);
      if (!project) return reply.code(404).send({ error: "project_not_found" });
      const num = Number(taskNum);
      if (!getTaskRow(project.id, num)) return reply.code(404).send({ error: "task_not_found" });

      const body = request.body as { answer: string };
      if (typeof body?.answer !== "string") {
        return reply.code(400).send({ error: "answer_required" });
      }
      const result = db
        .prepare(
          "UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND project_id = ? AND task_num = ?",
        )
        .run(body.answer, new Date().toISOString(), Number(id), project.id, num);
      if (result.changes === 0) {
        return reply.code(404).send({ error: "question_not_found" });
      }
      const question = db.prepare("SELECT * FROM questions WHERE id = ?").get(Number(id));
      return { question };
    },
  );

  app.get("/api/projects/:name/specs", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });
    const pmDir = pmDirFor(project.repo_dir);
    const specs = await listSpecs(pmDir);
    return { specs };
  });

  app.get("/api/projects/:name/adrs", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });
    const pmDir = pmDirFor(project.repo_dir);
    const adrs = await listAdrs(pmDir);
    return { adrs };
  });

  // Case-insensitive substring search across what's already cached for the
  // project: tasks (from the DB) and specs/ADRs (read fresh from .pm/, same
  // as their own list routes — there is no separate search index).
  app.get("/api/projects/:name/search", async (request, reply) => {
    const { name } = request.params as { name: string };
    const { q } = request.query as { q?: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const query = (q ?? "").trim();
    if (!query) return { results: [] };
    const needle = query.toLowerCase();

    const results: SearchResult[] = [];

    const taskRows = db
      .prepare("SELECT task_num, title, description FROM tasks WHERE project_id = ?")
      .all(project.id) as { task_num: number; title: string; description: string }[];
    for (const row of taskRows) {
      const haystack = `${row.title}\n${row.description}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      results.push({
        type: "task",
        taskNum: row.task_num,
        title: `#${row.task_num} ${row.title}`,
        snippet: snippetAround(row.description || row.title, needle),
      });
    }

    if (project.repo_dir) {
      const pmDir = pmDirFor(project.repo_dir);
      const [specs, adrs] = await Promise.all([listSpecs(pmDir), listAdrs(pmDir)]);
      for (const spec of specs) {
        const haystack = `${spec.name}\n${spec.body}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
        results.push({ type: "spec", title: spec.name, snippet: snippetAround(spec.body, needle) });
      }
      for (const adr of adrs) {
        const haystack = `${adr.title}\n${adr.body}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
        results.push({
          type: "adr",
          title: `ADR ${adr.id}: ${adr.title}`,
          snippet: snippetAround(adr.body, needle),
        });
      }
    }

    return { results: results.slice(0, 30) };
  });

  app.post("/api/projects/:name/tasks", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });

    const body = request.body as { title?: string; description?: string; status?: string };
    if (!body.title || typeof body.description !== "string") {
      return reply.code(400).send({ error: "title_and_description_required" });
    }
    const status: TaskStatus | undefined =
      body.status && isTaskStatus(body.status) ? body.status : undefined;

    const pmDir = pmDirFor(project.repo_dir);
    const task = await createTask(pmDir, {
      title: body.title,
      description: body.description,
      status,
    });
    await reindexTask(db, { id: project.id, repoDir: project.repo_dir }, task.id);
    const pushed = await commitAndPushBestEffort(name);

    const row = getTaskRow(project.id, task.id);
    return reply.code(201).send({ task: row && serializeTask(row), pushed });
  });

  app.patch("/api/projects/:name/tasks/:taskNum", async (request, reply) => {
    const { name, taskNum } = request.params as { name: string; taskNum: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });
    const num = Number(taskNum);
    const pmDir = pmDirFor(project.repo_dir);

    let task = await findTask(pmDir, num);
    if (!task) return reply.code(404).send({ error: "task_not_found" });

    const body = request.body as { description?: string; status?: string };
    if (typeof body.description === "string") {
      task = await writeTaskDescription(task, body.description);
    }
    if (body.status && isTaskStatus(body.status) && body.status !== task.status) {
      task = await moveTaskStatus(pmDir, task, body.status);
    }

    await reindexTask(db, { id: project.id, repoDir: project.repo_dir }, num);
    const pushed = await commitAndPushBestEffort(name);

    const row = getTaskRow(project.id, num);
    return { task: row && serializeTask(row), pushed };
  });

  app.post("/api/projects/:name/tasks/:taskNum/comments", async (request, reply) => {
    const { name, taskNum } = request.params as { name: string; taskNum: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });
    const num = Number(taskNum);
    const pmDir = pmDirFor(project.repo_dir);

    const task = await findTask(pmDir, num);
    if (!task) return reply.code(404).send({ error: "task_not_found" });

    const body = request.body as { author?: string; body?: string };
    if (typeof body.body !== "string" || !body.body.trim()) {
      return reply.code(400).send({ error: "body_required" });
    }
    await addComment(task, { author: body.author, body: body.body });
    await reindexTask(db, { id: project.id, repoDir: project.repo_dir }, num);
    const pushed = await commitAndPushBestEffort(name);

    const comments = db
      .prepare("SELECT * FROM comments WHERE project_id = ? AND task_num = ? ORDER BY comment_num")
      .all(project.id, num);
    return reply.code(201).send({ comments, pushed });
  });

  app.get("/api/projects/:name/tasks/:taskNum/attachments", async (request, reply) => {
    const { name, taskNum } = request.params as { name: string; taskNum: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });
    const pmDir = pmDirFor(project.repo_dir);

    const task = await findTask(pmDir, Number(taskNum));
    if (!task) return reply.code(404).send({ error: "task_not_found" });

    return { attachments: await listAttachments(task) };
  });

  app.post("/api/projects/:name/tasks/:taskNum/attachments", async (request, reply) => {
    const { name, taskNum } = request.params as { name: string; taskNum: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });
    const pmDir = pmDirFor(project.repo_dir);

    const task = await findTask(pmDir, Number(taskNum));
    if (!task) return reply.code(404).send({ error: "task_not_found" });

    const query = request.query as { filename?: string };
    let filename = query.filename;
    if (filename !== undefined && !isSafeFilename(filename)) {
      return reply.code(400).send({ error: "invalid_filename" });
    }
    if (!filename) {
      // Clipboard paste, no explicit name: mirror Claude chats' pasted-NN
      // convention, extension driven by what was actually pasted.
      const contentType = request.headers["content-type"] ?? "";
      const ext = contentType.startsWith("text/")
        ? "md"
        : extFor(contentType.split(";")[0]?.trim() ?? "");
      filename = await nextPastedName(task, { ext });
    }

    const data = request.body;
    if (typeof data !== "string" && !Buffer.isBuffer(data)) {
      return reply.code(400).send({ error: "body_required" });
    }
    await writeAttachment(task, filename, data);
    return reply.code(201).send({ filename });
  });

  app.get("/api/projects/:name/tasks/:taskNum/attachments/:filename", async (request, reply) => {
    const { name, taskNum, filename } = request.params as {
      name: string;
      taskNum: string;
      filename: string;
    };
    if (!isSafeFilename(filename)) return reply.code(400).send({ error: "invalid_filename" });
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    if (!project.repo_dir) return reply.code(409).send({ error: "project_has_no_repo" });
    const pmDir = pmDirFor(project.repo_dir);

    const task = await findTask(pmDir, Number(taskNum));
    if (!task) return reply.code(404).send({ error: "task_not_found" });

    try {
      const data = await readAttachment(task, filename);
      return reply.type(mimeFor(filename)).send(data);
    } catch {
      return reply.code(404).send({ error: "attachment_not_found" });
    }
  });

  app.get("/api/projects/:name/tasks/:taskNum/runs", async (request, reply) => {
    const { name, taskNum } = request.params as { name: string; taskNum: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    const num = Number(taskNum);
    const runs = db.prepare("SELECT * FROM runs WHERE project_id = ? AND task_num = ? ORDER BY id").all(project.id, num);
    return { runs };
  });

  app.post("/api/projects/:name/tasks/:taskNum/runs", async (request, reply) => {
    const { name, taskNum } = request.params as { name: string; taskNum: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    const num = Number(taskNum);
    const task = getTaskRow(project.id, num);
    if (!task) return reply.code(404).send({ error: "task_not_found" });

    const body = request.body as { phase?: string; provider?: string; model?: string; prompt?: string };
    if (!body.phase || !body.provider || !body.model) {
      return reply.code(400).send({ error: "phase_provider_model_required" });
    }

    const result = db.prepare(
      "INSERT INTO runs (project_id, task_num, phase, provider, model, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)"
    ).run(
      project.id,
      num,
      body.phase,
      body.provider,
      body.model,
      body.prompt || null,
      new Date().toISOString()
    );

    queueManager.trigger();

    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(result.lastInsertRowid);
    return reply.code(201).send({ run });
  });

  app.post("/api/runs/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(id)) as RunRow | undefined;
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (run.status !== "running" && run.status !== "queued") {
      return reply.code(409).send({ error: "run_not_active" });
    }

    if (run.status === "queued") {
      db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(new Date().toISOString(), run.id);
      return { stopped: true };
    }

    const project = getProjectById(run.project_id);
    if (!project) return reply.code(404).send({ error: "project_not_found" });
    const client = runners.client(project.name);
    if (!client) return reply.code(409).send({ error: "runner_not_connected" });

    // pm's own row id *is* the runner's run id, so a restarted pm can still
    // stop a run it did not start itself.
    const stopResult = await client.call("stopRun", { runId: run.id });
    if (stopResult.stopped) {
      db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(new Date().toISOString(), run.id);
    }
    return { stopped: stopResult.stopped };
  });

  app.get("/api/runs/:id/events", (request, reply) => {
    const { id } = request.params as { id: string };
    const runId = Number(id);
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!run) {
      reply.code(404).send({ error: "run_not_found" });
      return;
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    reply.raw.write(":\n\n");

    if (run.status !== "running" && run.status !== "queued") {
      if (run.log_path && existsSync(run.log_path)) {
        try {
          const content = readFileSync(run.log_path, "utf8");
          const lines = content.split("\n").filter(Boolean);
          for (const line of lines) {
            reply.raw.write(`data: ${JSON.stringify({ type: "log", runId, line })}\n\n`);
          }
        } catch (err) {
          console.error("error reading log file:", err);
        }
      }
      reply.raw.write(`data: ${JSON.stringify({ type: "end", runId })}\n\n`);
      reply.raw.end();
      return;
    }

    if (run.log_path && existsSync(run.log_path)) {
      try {
        const content = readFileSync(run.log_path, "utf8");
        const lines = content.split("\n").filter(Boolean);
        for (const line of lines) {
          reply.raw.write(`data: ${JSON.stringify({ type: "log", runId, line })}\n\n`);
        }
      } catch {
        // ignore
      }
    }

    const onLine = (line: string) => {
      reply.raw.write(`data: ${JSON.stringify({ type: "log", runId, line })}\n\n`);
    };

    const onEnd = () => {
      reply.raw.write(`data: ${JSON.stringify({ type: "end", runId })}\n\n`);
      reply.raw.end();
    };

    sseEmitter.on(`run-${runId}`, onLine);
    sseEmitter.once(`run-${runId}-end`, onEnd);

    request.raw.on("close", () => {
      sseEmitter.off(`run-${runId}`, onLine);
      sseEmitter.off(`run-${runId}-end`, onEnd);
    });
  });

  // Verify artifacts live in PM_DATA_DIR, not the repo working tree — queue.ts
  // copies them there after a verify run so they survive a rebuild of the repo's
  // .pm/ cache. `runNum` is `task_runs.run_num`, which queue.ts now forces to
  // equal the runtime `runs.id`, so it doubles as the artifacts directory name.
  // TODO(retention): PM_DATA_DIR/artifacts grows without bound — the plan calls
  // for retention on raw logs and verify artifacts, but no policy (age, count,
  // size) is specified anywhere. Needs a decision before this ships long-term.

  app.get("/api/projects/:name/tasks/:taskNum/runs/:runNum/artifacts", async (request, reply) => {
    const { name, runNum } = request.params as {
      name: string;
      runNum: string;
    };
    if (!isSafeRunNum(runNum)) return reply.code(400).send({ error: "invalid_run_num" });
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const artifactsDir = join(process.env.PM_DATA_DIR || ".", "artifacts", runNum);

    try {
      const files = await readdir(artifactsDir);
      return { artifacts: files };
    } catch {
      return { artifacts: [] };
    }
  });

  app.get("/api/projects/:name/tasks/:taskNum/runs/:runNum/artifacts/:filename", async (request, reply) => {
    const { name, runNum, filename } = request.params as {
      name: string;
      runNum: string;
      filename: string;
    };
    if (!isSafeRunNum(runNum)) return reply.code(400).send({ error: "invalid_run_num" });
    if (!isSafeFilename(filename)) return reply.code(400).send({ error: "invalid_filename" });

    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const filePath = join(process.env.PM_DATA_DIR || ".", "artifacts", runNum, filename);

    try {
      const data = readFileSync(filePath);
      return reply.type(mimeFor(filename)).send(data);
    } catch {
      return reply.code(404).send({ error: "artifact_file_not_found" });
    }
  });

  // ─── Cost roll-ups (T37) ─────────────────────────────────────────────────
  // Aggregated from task_runs (the .pm/ cache), not the runtime `runs` table —
  // costs are written into the run's outcome file in .pm/, so totals survive
  // a cache rebuild. The runtime table is wiped on restart in ways task_runs
  // is not.

  app.get("/api/costs/mtd", async () => {
    const month = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) as total FROM task_runs WHERE cost_usd IS NOT NULL AND finished_at LIKE ?",
      )
      .get(`${month}%`) as { total: number };
    return { totalUsd: row.total, month };
  });

  app.get("/api/projects/:name/costs", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const taskTotals = db
      .prepare(
        "SELECT task_num, COALESCE(SUM(cost_usd), 0) as total_usd FROM task_runs WHERE project_id = ? AND cost_usd IS NOT NULL GROUP BY task_num",
      )
      .all(project.id) as { task_num: number; total_usd: number }[];

    const projectTotal = (
      db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) as total FROM task_runs WHERE project_id = ? AND cost_usd IS NOT NULL",
        )
        .get(project.id) as { total: number }
    ).total;

    return { taskTotals, projectTotal };
  });

  // ─── Project lifecycle toggle (T35) ──────────────────────────────────────

  app.post("/api/projects/:name/lifecycle", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const body = request.body as { action?: string; alwaysOn?: boolean };
    if (!body.action) return reply.code(400).send({ error: "action_required" });

    if (body.action === "set-always-on") {
      const val = body.alwaysOn ? 1 : 0;
      db.prepare("UPDATE projects SET always_on = ?, updated_at = ? WHERE id = ?").run(
        val,
        new Date().toISOString(),
        project.id,
      );
      return { ok: true, alwaysOn: Boolean(val) };
    }

    if (body.action === "start" || body.action === "stop") {
      const result = await callProjectctl(body.action, { name });
      if (result.ok) {
        const lifecycle = body.action === "start" ? "active" : "stopped";
        db.prepare("UPDATE projects SET lifecycle = ?, updated_at = ? WHERE id = ?").run(
          lifecycle,
          new Date().toISOString(),
          project.id,
        );
      }
      return { ok: result.ok, message: result.message };
    }

    return reply.code(400).send({ error: "unknown_action" });
  });

  // ─── Providers (T36) ─────────────────────────────────────────────────────

  // Provider id -> display metadata. The model list itself is *not* here —
  // it comes from each adapter's models(), which is the single source of
  // truth (see core/src/pm/adapters/*.ts). Two copies of the same list going
  // stale independently is exactly what broke this before.
  const PROVIDER_META: Record<string, { name: string; authType: "api-key" | "oauth" }> = {
    claude: { name: "Claude (Anthropic)", authType: "api-key" },
    // TODO: antigravity is an OAuth product and `agy auth login` is the
    // native flow, but no OAuth handler exists anywhere in pm — advertising
    // "oauth" here while the UI only offers a key field was a straight
    // contradiction. Until that flow is built this is an API key like any
    // other; revisit when there is something to redirect to.
    antigravity: { name: "Antigravity", authType: "api-key" },
  };

  app.get("/api/providers", async () => {
    const providerDefs = await Promise.all(
      Object.entries(PROVIDER_META).map(async ([id, meta]) => ({
        id,
        name: meta.name,
        authType: meta.authType,
        models: await getAdapter(id).models(),
      })),
    );

    const credRows = db.prepare("SELECT * FROM provider_creds").all() as {
      provider: string;
      masked_key: string;
      connected_at: string;
      account: string | null;
    }[];

    return {
      providers: providerDefs.map((p) => {
        const cred = credRows.find((c) => c.provider === p.id);
        return {
          ...p,
          connected: Boolean(cred),
          maskedKey: cred?.masked_key ?? null,
          connectedAt: cred?.connected_at ?? null,
          account: cred?.account ?? null,
        };
      }),
    };
  });

  /**
   * Store a provider key and push it into every project user's ~/.pm-creds/.
   *
   * There is no `_pm` project — credentials are per-project by design, so this
   * fans out. The rule on partial failure is all-or-nothing *reporting*: the
   * `provider_creds` row is only written when every project accepted the key,
   * so a provider never shows "connected" while some project is missing it.
   * Whatever did land stays on disk, and a retry is safe (`set-credential`
   * overwrites), so the response names exactly which projects failed.
   */
  app.post("/api/providers/:provider/connect", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const body = request.body as { type?: string; key?: string };

    const credKey = PROVIDER_CREDENTIAL_KEYS[provider];
    if (!credKey) return reply.code(404).send({ error: "unknown_provider" });
    if (body?.type !== "api-key") return reply.code(400).send({ error: "unsupported_auth_type" });
    if (!body.key || typeof body.key !== "string" || !body.key.trim()) {
      return reply.code(400).send({ error: "key_required" });
    }

    const key = body.key.trim();
    const seed: CredentialSeed = { provider, key: credKey, value: key };
    const projects = db.prepare("SELECT name FROM projects ORDER BY name").all() as {
      name: string;
    }[];

    const results: DeliveryResult[] = [];
    for (const project of projects) {
      results.push(await deliverCredential(project.name, seed));
    }

    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      return reply.code(502).send({
        ok: false,
        error: "credential_delivery_failed",
        message: `wrote the key to ${results.length - failures.length} of ${results.length} projects`,
        failures: failures.map((f) => ({ project: f.project, message: f.message })),
      });
    }

    // Zero projects is a clean success: the key is held and every project
    // created from here on is seeded with it (see POST /api/projects).
    const masked = maskKey(key);
    db.prepare(
      "INSERT INTO provider_creds (provider, masked_key, secret, connected_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET masked_key = excluded.masked_key, secret = excluded.secret, connected_at = excluded.connected_at",
    ).run(provider, masked, key, new Date().toISOString());

    return { ok: true, maskedKey: masked, projectsUpdated: results.length };
  });

  app.patch("/api/projects/:name/defaults", async (request, reply) => {
    const { name } = request.params as { name: string };
    const project = getProjectRow(name);
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const body = request.body as { provider?: string; model?: string };
    db.prepare(
      "UPDATE projects SET default_provider = ?, default_model = ?, updated_at = ? WHERE id = ?",
    ).run(
      body.provider ?? project.default_provider,
      body.model ?? project.default_model,
      new Date().toISOString(),
      project.id,
    );

    const updated = getProjectRow(name)!;
    return serializeProject(updated, runners.state(updated.name));
  });

  // ─── Static SPA ──────────────────────────────────────────────────────────
  // nginx proxies `location /` straight here, so the API server is also the
  // origin for the UI. Skipped when web/dist is absent (unit tests, and any
  // API-only run) so the tests keep getting JSON 404s.

  const webRoot = resolveWebRoot();
  if (existsSync(webRoot)) {
    // wildcard:false registers one route per built file instead of a catch-all
    // `/*`. That matters: a catch-all would also swallow unmatched /api/…
    // requests and answer them with @fastify/static's HTML-ish 404 instead of
    // the JSON shape the client expects.
    app.register(fastifyStatic, { root: webRoot, wildcard: false });

    // Client-side routes (/specs, /adrs, /projects/x/tasks/1) have no file
    // behind them; hand them index.html and let react-router resolve. Anything
    // under /api, and anything that isn't a GET, still 404s as JSON.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
