import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter, stringifyFrontMatter } from "./frontmatter.js";
import { safeReaddir } from "./fs-helpers.js";
import { formatId, nextId, parseLeadingId } from "./ids.js";
import { slugify } from "./slug.js";
import { TASK_STATUSES, statusDir, taskDir, type TaskStatus } from "./paths.js";

function isoNow(): string {
  return new Date().toISOString();
}

interface TaskFrontMatter {
  id: number;
  title: string;
  created: string;
  branch: string | null;
}

export interface TaskRecord {
  readonly id: number;
  readonly slug: string;
  readonly status: TaskStatus;
  readonly title: string;
  readonly created: string;
  readonly branch: string | null;
  readonly description: string;
  /** Absolute path to the task's folder. */
  readonly dir: string;
}

async function taskDirNames(pmDir: string, status: TaskStatus): Promise<string[]> {
  return (await safeReaddir(statusDir(pmDir, status))).filter(
    (name) => parseLeadingId(name) !== null,
  );
}

export async function nextTaskId(pmDir: string): Promise<number> {
  const names: string[] = [];
  for (const status of TASK_STATUSES) {
    names.push(...(await taskDirNames(pmDir, status)));
  }
  return nextId(names);
}

function slugFromDirName(dirName: string): string {
  return dirName.slice(dirName.indexOf("-") + 1);
}

function taskFrontMatter(
  task: Pick<TaskRecord, "id" | "title" | "created" | "branch">,
): TaskFrontMatter {
  return { id: task.id, title: task.title, created: task.created, branch: task.branch };
}

async function writeTaskIndex(
  dir: string,
  front: TaskFrontMatter,
  description: string,
): Promise<void> {
  await writeFile(
    join(dir, "index.md"),
    stringifyFrontMatter(front as unknown as Record<string, unknown>, description),
    "utf8",
  );
}

export interface CreateTaskOptions {
  readonly title: string;
  readonly description: string;
  readonly status?: TaskStatus;
  /** Force a specific id instead of computing the next free one (tests, imports). */
  readonly id?: number;
  readonly now?: () => string;
}

export async function createTask(pmDir: string, opts: CreateTaskOptions): Promise<TaskRecord> {
  const status = opts.status ?? "todo";
  const id = opts.id ?? (await nextTaskId(pmDir));
  const slug = slugify(opts.title);
  const dir = taskDir(pmDir, status, id, slug);
  await mkdir(join(dir, "comments"), { recursive: true });
  await mkdir(join(dir, "runs"), { recursive: true });
  await mkdir(join(dir, "attachments"), { recursive: true });
  const created = (opts.now ?? isoNow)();
  const front: TaskFrontMatter = { id, title: opts.title, created, branch: null };
  await writeTaskIndex(dir, front, opts.description);
  return {
    id,
    slug,
    status,
    title: opts.title,
    created,
    branch: null,
    description: opts.description,
    dir,
  };
}

export async function readTask(
  pmDir: string,
  status: TaskStatus,
  dirName: string,
): Promise<TaskRecord> {
  const dir = join(statusDir(pmDir, status), dirName);
  const raw = await readFile(join(dir, "index.md"), "utf8");
  const { data, body } = parseFrontMatter<TaskFrontMatter>(raw);
  return {
    id: data.id,
    slug: slugFromDirName(dirName),
    status,
    title: data.title,
    created: data.created,
    branch: data.branch ?? null,
    description: body,
    dir,
  };
}

/** Locates one task by id without parsing every task's index.md, unlike listTasks. */
export async function findTask(pmDir: string, id: number): Promise<TaskRecord | null> {
  for (const status of TASK_STATUSES) {
    const match = (await taskDirNames(pmDir, status)).find((name) => parseLeadingId(name) === id);
    if (match) return readTask(pmDir, status, match);
  }
  return null;
}

export async function listTasks(pmDir: string): Promise<TaskRecord[]> {
  const records: TaskRecord[] = [];
  for (const status of TASK_STATUSES) {
    const names = (await taskDirNames(pmDir, status)).sort();
    for (const name of names) {
      records.push(await readTask(pmDir, status, name));
    }
  }
  return records;
}

export async function writeTaskDescription(
  task: TaskRecord,
  description: string,
): Promise<TaskRecord> {
  await writeTaskIndex(task.dir, taskFrontMatter(task), description);
  return { ...task, description };
}

export async function setTaskBranch(task: TaskRecord, branch: string): Promise<TaskRecord> {
  await writeTaskIndex(task.dir, taskFrontMatter({ ...task, branch }), task.description);
  return { ...task, branch };
}

/** Moves a task's folder to another status, i.e. the fs side of a `git mv`. */
export async function moveTaskStatus(
  pmDir: string,
  task: TaskRecord,
  toStatus: TaskStatus,
): Promise<TaskRecord> {
  if (toStatus === task.status) return task;
  const newDir = taskDir(pmDir, toStatus, task.id, task.slug);
  await mkdir(statusDir(pmDir, toStatus), { recursive: true });
  await rename(task.dir, newDir);
  return { ...task, status: toStatus, dir: newDir };
}

// -- comments ----------------------------------------------------------------

interface CommentFrontMatter {
  author: string | null;
  created: string;
}

export interface CommentRecord {
  readonly num: number;
  readonly author: string | null;
  readonly created: string;
  readonly body: string;
  readonly path: string;
}

export interface AddCommentOptions {
  readonly author?: string;
  readonly body: string;
  readonly now?: () => string;
}

export async function addComment(
  task: TaskRecord,
  opts: AddCommentOptions,
): Promise<CommentRecord> {
  const dir = join(task.dir, "comments");
  await mkdir(dir, { recursive: true });
  const num = nextId(await safeReaddir(dir));
  const created = (opts.now ?? isoNow)();
  const path = join(dir, `${formatId(num)}.md`);
  const front: CommentFrontMatter = { author: opts.author ?? null, created };
  await writeFile(
    path,
    stringifyFrontMatter(front as unknown as Record<string, unknown>, opts.body),
    "utf8",
  );
  return { num, author: front.author, created, body: opts.body, path };
}

export async function listComments(task: TaskRecord): Promise<CommentRecord[]> {
  const dir = join(task.dir, "comments");
  const names = (await safeReaddir(dir)).filter((n) => n.endsWith(".md")).sort();
  const comments: CommentRecord[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const { data, body } = parseFrontMatter<CommentFrontMatter>(await readFile(path, "utf8"));
    comments.push({
      num: parseLeadingId(name) ?? 0,
      author: data.author ?? null,
      created: data.created,
      body,
      path,
    });
  }
  return comments;
}

// -- runs (task_runs cache source) -------------------------------------------

export interface RunFrontMatter {
  phase: string;
  provider: string;
  model: string;
  status: string;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunRecord {
  readonly num: number;
  readonly frontMatter: RunFrontMatter;
  readonly outcome: string;
  readonly path: string;
}

export interface AddRunOutcomeOptions {
  /** Force a specific run number, e.g. to match the runtime `runs.id`. */
  readonly num?: number;
}

export async function addRunOutcome(
  task: TaskRecord,
  frontMatter: RunFrontMatter,
  outcome: string,
  opts: AddRunOutcomeOptions = {},
): Promise<RunRecord> {
  const dir = join(task.dir, "runs");
  await mkdir(dir, { recursive: true });
  const num = opts.num ?? nextId(await safeReaddir(dir));
  const path = join(dir, `${formatId(num)}.md`);
  await writeFile(
    path,
    stringifyFrontMatter(frontMatter as unknown as Record<string, unknown>, outcome),
    "utf8",
  );
  return { num, frontMatter, outcome, path };
}

export async function listRuns(task: TaskRecord): Promise<RunRecord[]> {
  const dir = join(task.dir, "runs");
  const names = (await safeReaddir(dir)).filter((n) => n.endsWith(".md")).sort();
  const runs: RunRecord[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const { data, body } = parseFrontMatter<RunFrontMatter>(await readFile(path, "utf8"));
    runs.push({ num: parseLeadingId(name) ?? 0, frontMatter: data, outcome: body, path });
  }
  return runs;
}

// -- attachments --------------------------------------------------------------

export async function writeAttachment(
  task: TaskRecord,
  filename: string,
  data: Buffer | string,
): Promise<string> {
  const dir = join(task.dir, "attachments");
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, data);
  return path;
}

export async function readAttachment(task: TaskRecord, filename: string): Promise<Buffer> {
  return readFile(join(task.dir, "attachments", filename));
}

export async function listAttachments(task: TaskRecord): Promise<string[]> {
  return (await safeReaddir(join(task.dir, "attachments"))).sort();
}

/** Next free `pasted-NN.<ext>` name for a clipboard paste (text or image). */
export async function nextPastedName(
  task: TaskRecord,
  opts: { readonly prefix?: string; readonly ext?: string } = {},
): Promise<string> {
  const prefix = opts.prefix ?? "pasted";
  const ext = opts.ext ?? "md";
  const existing = await listAttachments(task);
  const matching = existing
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(`.${ext}`))
    .map((name) => name.slice(prefix.length + 1));
  return `${prefix}-${formatId(nextId(matching))}.${ext}`;
}
