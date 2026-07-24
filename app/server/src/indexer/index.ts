import type Database from "better-sqlite3";
import { findTask, listComments, listRuns, listTasks, pmDirFor, type TaskRecord, detectContract } from "@pm/core";
import {
  deleteProjectCache,
  deleteTaskCache,
  replaceComments,
  replaceTaskRuns,
  upsertTaskRow,
} from "./upsert.js";

export interface IndexedProject {
  readonly id: number;
  readonly repoDir: string;
}

export interface IndexStats {
  readonly tasks: number;
  readonly comments: number;
  readonly runs: number;
}

function defaultNow(): string {
  return new Date().toISOString();
}

async function indexTask(
  db: Database.Database,
  projectId: number,
  task: TaskRecord,
  now: string,
): Promise<{ comments: number; runs: number }> {
  const comments = await listComments(task);
  const runs = await listRuns(task);
  db.transaction(() => {
    upsertTaskRow(db, projectId, task, now);
    replaceComments(db, projectId, task.id, comments);
    replaceTaskRuns(db, projectId, task.id, runs);
  })();
  return { comments: comments.length, runs: runs.length };
}

/** Full rebuild: wipes this project's cache and re-derives it from the working tree. */
export async function rebuildIndex(
  db: Database.Database,
  project: IndexedProject,
  now: () => string = defaultNow,
): Promise<IndexStats> {
  const nameRow = db.prepare("SELECT name FROM projects WHERE id = ?").get(project.id) as { name: string } | undefined;
  const projectName = nameRow?.name || "";
  const contract = await detectContract(project.repoDir, projectName);
  
  db.transaction(() => {
    db.prepare("UPDATE projects SET contract_json = ? WHERE id = ?").run(
      JSON.stringify(contract),
      project.id,
    );
  })();

  const pmDir = pmDirFor(project.repoDir);
  const tasks = await listTasks(pmDir);
  db.transaction(() => deleteProjectCache(db, project.id))();

  let comments = 0;
  let runs = 0;
  const ts = now();
  for (const task of tasks) {
    const result = await indexTask(db, project.id, task, ts);
    comments += result.comments;
    runs += result.runs;
  }
  return { tasks: tasks.length, comments, runs };
}

/**
 * Incrementally re-indexes one task after pm writes to its files (a comment, a
 * description edit, a status move), without rescanning every other task.
 * Returns false and removes any cached row if the task no longer exists on disk.
 */
export async function reindexTask(
  db: Database.Database,
  project: IndexedProject,
  taskId: number,
  now: () => string = defaultNow,
): Promise<boolean> {
  const nameRow = db.prepare("SELECT name FROM projects WHERE id = ?").get(project.id) as { name: string } | undefined;
  const projectName = nameRow?.name || "";
  const contract = await detectContract(project.repoDir, projectName);

  db.transaction(() => {
    db.prepare("UPDATE projects SET contract_json = ? WHERE id = ?").run(
      JSON.stringify(contract),
      project.id,
    );
  })();

  const pmDir = pmDirFor(project.repoDir);
  const task = await findTask(pmDir, taskId);
  if (!task) {
    db.transaction(() => deleteTaskCache(db, project.id, taskId))();
    return false;
  }
  await indexTask(db, project.id, task, now());
  return true;
}
