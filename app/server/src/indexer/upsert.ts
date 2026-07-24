import type Database from "better-sqlite3";
import type { CommentRecord, RunRecord, TaskRecord } from "@pm/core";

export function upsertTaskRow(
  db: Database.Database,
  projectId: number,
  task: TaskRecord,
  now: string,
): void {
  db.prepare(
    `
    INSERT INTO tasks
      (project_id, task_num, slug, status, title, description, branch, path, created_at, updated_at)
    VALUES (@projectId, @taskNum, @slug, @status, @title, @description, @branch, @path, @createdAt, @updatedAt)
    ON CONFLICT (project_id, task_num) DO UPDATE SET
      slug = excluded.slug,
      status = excluded.status,
      title = excluded.title,
      description = excluded.description,
      branch = excluded.branch,
      path = excluded.path,
      updated_at = excluded.updated_at
    `,
  ).run({
    projectId,
    taskNum: task.id,
    slug: task.slug,
    status: task.status,
    title: task.title,
    description: task.description,
    branch: task.branch,
    path: task.dir,
    createdAt: task.created,
    updatedAt: now,
  });
}

export function replaceComments(
  db: Database.Database,
  projectId: number,
  taskNum: number,
  comments: readonly CommentRecord[],
): void {
  db.prepare("DELETE FROM comments WHERE project_id = ? AND task_num = ?").run(projectId, taskNum);
  const insert = db.prepare(
    `INSERT INTO comments (project_id, task_num, comment_num, author, body, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const comment of comments) {
    insert.run(
      projectId,
      taskNum,
      comment.num,
      comment.author,
      comment.body,
      comment.path,
      comment.created,
    );
  }
}

export function replaceTaskRuns(
  db: Database.Database,
  projectId: number,
  taskNum: number,
  runs: readonly RunRecord[],
): void {
  db.prepare("DELETE FROM task_runs WHERE project_id = ? AND task_num = ?").run(projectId, taskNum);
  const insert = db.prepare(
    `INSERT INTO task_runs
       (project_id, task_num, run_num, phase, provider, model, status,
        cost_usd, tokens_in, tokens_out, started_at, finished_at, outcome, path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const run of runs) {
    const fm = run.frontMatter;
    insert.run(
      projectId,
      taskNum,
      run.num,
      fm.phase,
      fm.provider,
      fm.model,
      fm.status,
      fm.costUsd,
      fm.tokensIn,
      fm.tokensOut,
      fm.startedAt,
      fm.finishedAt,
      run.outcome,
      run.path,
    );
  }
}

export function deleteTaskCache(db: Database.Database, projectId: number, taskNum: number): void {
  db.prepare("DELETE FROM task_runs WHERE project_id = ? AND task_num = ?").run(projectId, taskNum);
  db.prepare("DELETE FROM comments WHERE project_id = ? AND task_num = ?").run(projectId, taskNum);
  db.prepare("DELETE FROM tasks WHERE project_id = ? AND task_num = ?").run(projectId, taskNum);
}

export function deleteProjectCache(db: Database.Database, projectId: number): void {
  db.prepare("DELETE FROM task_runs WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM comments WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
}
