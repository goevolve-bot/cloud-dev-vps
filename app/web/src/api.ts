export interface ContractState {
  readonly composeFileExists: boolean;
  readonly mainServiceExists: boolean;
  readonly mainServiceHasHealthcheck: boolean;
  readonly hasTest: boolean;
  readonly hasE2E: boolean;
  readonly hasUI: boolean;
  readonly isCompliant: boolean;
}

export interface Project {
  readonly id: number;
  readonly name: string;
  readonly gitUrl: string;
  readonly repoDir: string | null;
  readonly defaultProvider: string | null;
  readonly defaultModel: string | null;
  readonly contract: ContractState | null;
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

export function attachmentUrl(project: string, taskId: number, filename: string): string {
  return `/api/projects/${project}/tasks/${taskId}/attachments/${encodeURIComponent(filename)}`;
}

export async function fetchAttachments(project: string, taskId: number): Promise<string[]> {
  const body = await getJson<{ attachments: string[] }>(
    `/api/projects/${project}/tasks/${taskId}/attachments`,
  );
  return body.attachments;
}

export interface UploadAttachmentInput {
  /** Omit for a clipboard paste — the server picks a pasted-NN name. */
  readonly filename?: string;
  readonly contentType: string;
  readonly data: Blob | string;
}

export async function uploadAttachment(
  project: string,
  taskId: number,
  input: UploadAttachmentInput,
): Promise<string> {
  const query = input.filename ? `?filename=${encodeURIComponent(input.filename)}` : "";
  const response = await fetch(`/api/projects/${project}/tasks/${taskId}/attachments${query}`, {
    method: "POST",
    headers: { "content-type": input.contentType },
    body: input.data,
  });
  if (!response.ok) {
    throw new Error(`upload attachment responded ${response.status}`);
  }
  const body = (await response.json()) as { filename: string };
  return body.filename;
}

export interface Comment {
  readonly id: number;
  readonly project_id: number;
  readonly task_num: number;
  readonly comment_num: number;
  readonly author: string | null;
  readonly body: string;
  readonly path: string;
  readonly created_at: string;
}

export interface TaskRun {
  readonly id: number;
  readonly project_id: number;
  readonly task_num: number;
  readonly run_num: number;
  readonly phase: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: string | null;
  readonly cost_usd: number | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly outcome: string;
  readonly path: string;
}

export interface QueueRun {
  readonly id: number;
  readonly project_id: number;
  readonly task_num: number;
  readonly phase: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string | null;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly exit_code: number | null;
  readonly log_path: string | null;
  readonly cost_usd: number | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export async function createComment(
  project: string,
  taskId: number,
  input: { author?: string; body: string },
): Promise<Comment[]> {
  const body = await sendJson<{ comments: Comment[] }>(
    `/api/projects/${project}/tasks/${taskId}/comments`,
    "POST",
    input,
  );
  return body.comments;
}

export interface Question {
  readonly id: number;
  readonly project_id: number;
  readonly task_num: number;
  readonly run_id: number;
  readonly text: string;
  readonly answer: string | null;
  readonly answered_at: string | null;
}

export interface Spec {
  readonly name: string;
  readonly body: string;
  readonly path: string;
}

export interface Adr {
  readonly id: number;
  readonly title: string;
  readonly status: "accepted" | "superseded" | "abandoned";
  readonly supersededBy: number | null;
  readonly body: string;
  readonly path: string;
}

export async function fetchTaskDetails(
  project: string,
  taskId: number,
): Promise<{ task: Task; comments: Comment[]; runs: TaskRun[]; queueRuns: QueueRun[]; questions: Question[]; plan: string | null }> {
  return getJson<{ task: Task; comments: Comment[]; runs: TaskRun[]; queueRuns: QueueRun[]; questions: Question[]; plan: string | null }>(
    `/api/projects/${project}/tasks/${taskId}`,
  );
}

export async function createRun(
  project: string,
  taskId: number,
  input: { phase: string; provider: string; model: string; prompt?: string },
): Promise<QueueRun> {
  const body = await sendJson<{ run: QueueRun }>(
    `/api/projects/${project}/tasks/${taskId}/runs`,
    "POST",
    input,
  );
  return body.run;
}

export async function stopRun(runId: number): Promise<boolean> {
  const response = await fetch(`/api/runs/${runId}/stop`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`Stop run responded ${response.status}`);
  }
  const body = (await response.json()) as { stopped: boolean };
  return body.stopped;
}

export async function answerQuestion(questionId: number, answer: string): Promise<Question> {
  const body = await sendJson<{ question: Question }>(
    `/api/questions/${questionId}/answer`,
    "POST",
    { answer },
  );
  return body.question;
}

export async function fetchSpecs(project: string): Promise<Spec[]> {
  const body = await getJson<{ specs: Spec[] }>(`/api/projects/${project}/specs`);
  return body.specs;
}

export async function fetchAdrs(project: string): Promise<Adr[]> {
  const body = await getJson<{ adrs: Adr[] }>(`/api/projects/${project}/adrs`);
  return body.adrs;
}

// ─── Cost roll-ups (T37) ─────────────────────────────────────────────────────

export interface MtdCost {
  readonly totalUsd: number;
  readonly month: string;
}

export async function fetchMtdCost(): Promise<MtdCost> {
  return getJson<MtdCost>("/api/costs/mtd");
}

export interface ProjectCosts {
  readonly taskTotals: { task_num: number; total_usd: number }[];
  readonly projectTotal: number;
}

export async function fetchProjectCosts(project: string): Promise<ProjectCosts> {
  return getJson<ProjectCosts>(`/api/projects/${project}/costs`);
}

// ─── Lifecycle (T35) ─────────────────────────────────────────────────────────

export async function setProjectLifecycle(
  project: string,
  action: "start" | "stop" | "set-always-on",
  alwaysOn?: boolean,
): Promise<{ ok: boolean; alwaysOn?: boolean }> {
  return sendJson(`/api/projects/${project}/lifecycle`, "POST", { action, alwaysOn });
}

// ─── Provider setup (T36) ────────────────────────────────────────────────────

export interface ProviderModel {
  readonly id: string;
  readonly name: string;
}

export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly authType: "api-key" | "oauth";
  readonly models: ProviderModel[];
  readonly connected: boolean;
  readonly maskedKey: string | null;
  readonly connectedAt: string | null;
  readonly account: string | null;
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const body = await getJson<{ providers: ProviderInfo[] }>("/api/providers");
  return body.providers;
}

export async function connectProvider(
  provider: string,
  input: { type: "api-key"; key: string },
): Promise<{ ok: boolean; maskedKey: string }> {
  return sendJson(`/api/providers/${provider}/connect`, "POST", input);
}

export async function updateProjectDefaults(
  project: string,
  input: { provider?: string; model?: string },
): Promise<Project> {
  return sendJson<Project>(`/api/projects/${project}/defaults`, "PATCH", input);
}

