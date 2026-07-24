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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchProjects(): Promise<Project[]> {
  const body = await getJson<{ projects: Project[] }>("/api/projects");
  return body.projects;
}
