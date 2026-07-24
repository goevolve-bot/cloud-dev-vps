import { useCallback, useEffect, useState } from "react";
import { fetchProjects, type Project } from "../api";

export interface UseProjectsResult {
  readonly projects: Project[] | null;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((data) => {
        if (!cancelled) setProjects(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { projects, error, refresh };
}
