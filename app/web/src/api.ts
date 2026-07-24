export interface Project {
  readonly id: number;
  readonly name: string;
  readonly gitUrl: string;
  readonly repoDir: string | null;
  readonly defaultProvider: string | null;
  readonly defaultModel: string | null;
  readonly lifecycle: string;
  readonly alwaysOn: boolean;
  readonly runnerState: "connected" | "disconnected";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const TASK_STATUSES = [
  "todo",
  "in-progress",
  "ready-for-review",
  "done",
  "blocked",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  readonly id: number;
  readonly slug: string;
  readonly status: TaskStatus;
  readonly title: string;
  readonly description: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

async function sendJson<T>(url: string, method: "POST" | "PATCH", payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`${method} ${url} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchProjects(): Promise<Project[]> {
  const body = await getJson<{ projects: Project[] }>("/api/projects");
  return body.projects;
}

export async function fetchTasks(project: string): Promise<Task[]> {
  const body = await getJson<{ tasks: Task[] }>(`/api/projects/${project}/tasks`);
  return body.tasks;
}

export async function createTask(
  project: string,
  input: { title: string; description: string },
): Promise<Task> {
  const body = await sendJson<{ task: Task }>(`/api/projects/${project}/tasks`, "POST", input);
  return body.task;
}

export async function updateTask(
  project: string,
  taskId: number,
  input: { description?: string; status?: TaskStatus },
): Promise<Task> {
  const body = await sendJson<{ task: Task }>(
    `/api/projects/${project}/tasks/${taskId}`,
    "PATCH",
    input,
  );
  return body.task;
}
