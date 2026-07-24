import { join } from "node:path";
import { formatId } from "./ids.js";

export const TASK_STATUSES = [
  "todo",
  "in-progress",
  "ready-for-review",
  "done",
  "blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/** `.pm/` directory for a repo checkout. */
export function pmDirFor(repoDir: string): string {
  return join(repoDir, ".pm");
}

export function tasksRoot(pmDir: string): string {
  return join(pmDir, "tasks");
}

export function statusDir(pmDir: string, status: TaskStatus): string {
  return join(tasksRoot(pmDir), status);
}

export function taskDirName(id: number, slug: string): string {
  return `${formatId(id)}-${slug}`;
}

export function taskDir(pmDir: string, status: TaskStatus, id: number, slug: string): string {
  return join(statusDir(pmDir, status), taskDirName(id, slug));
}

export function specsDir(pmDir: string): string {
  return join(pmDir, "specs");
}

export function adrsDir(pmDir: string): string {
  return join(pmDir, "adrs");
}
