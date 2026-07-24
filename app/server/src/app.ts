import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import {
  addComment,
  createTask,
  findTask,
  isTaskStatus,
  listAttachments,
  moveTaskStatus,
  nextPastedName,
  pmDirFor,
  readAttachment,
  writeAttachment,
  writeTaskDescription,
  type TaskStatus,
} from "@pm/core";
import { reindexTask } from "./indexer/index.js";
import type { RunnerRegistry } from "./runners/registry.js";

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

function serializeProject(row: ProjectRow, runnerState: string) {
  return {
    id: row.id,
    name: row.name,
    gitUrl: row.git_url,
    repoDir: row.repo_dir,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
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

// A single path segment, no separators — closes off traversal outside the
// task's attachments/ directory regardless of what @pm/core does with it.
const SAFE_FILENAME_RE = /^[^/\\]+$/;

function isSafeFilename(name: string): boolean {
  return SAFE_FILENAME_RE.test(name) && name !== "." && name !== ".." && !name.includes("\0");
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db, runners } = ctx;

  // application/json and text/plain already have built-in parsers; this is
  // the fallback for attachment uploads (images, arbitrary files).
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  function getProjectRow(name: string): ProjectRow | undefined {
    return db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRow | undefined;
  }

  function getTaskRow(projectId: number, taskNum: number): TaskRow | undefined {
    return db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND task_num = ?")
      .get(projectId, taskNum) as TaskRow | undefined;
  }

  /**
   * .pm/ writes commit on the runner's pinned default-branch checkout, not a
   * task branch — the exact branch-name contract for that call is T22's job.
   * commitAndPush is still stubbed (T10), so this is inherently best-effort:
   * a task/comment always lands on disk and in the cache even if nothing is
   * connected yet to push it.
   */
  async function commitAndPushBestEffort(projectName: string): Promise<boolean> {
    const client = runners.client(projectName);
    if (!client) return false;
    try {
      await client.call("commitAndPush", { branch: "" });
      return true;
    } catch {
      return false;
    }
  }

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/projects", async () => {
    const rows = db.prepare("SELECT * FROM projects ORDER BY name").all() as ProjectRow[];
    return { projects: rows.map((row) => serializeProject(row, runners.state(row.name))) };
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
    return { task: serializeTask(task), comments, runs };
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

  return app;
}
