import { useCallback, useEffect, useState } from "react";
import { fetchTasks, type Task } from "../api";

export interface UseTasksResult {
  readonly tasks: Task[] | null;
  readonly error: string | null;
  readonly refresh: () => void;
  /** Merges an updated/created task into the local list without a round-trip. */
  readonly upsertLocal: (task: Task) => void;
}

export function useTasks(project: string): UseTasksResult {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    setError(null);
    fetchTasks(project)
      .then((data) => {
        if (!cancelled) setTasks(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [project, generation]);

  const refresh = useCallback(() => setGeneration((n) => n + 1), []);

  const upsertLocal = useCallback((task: Task) => {
    setTasks((current) => {
      if (!current) return current;
      const index = current.findIndex((t) => t.id === task.id);
      if (index === -1) return [...current, task];
      const next = current.slice();
      next[index] = task;
      return next;
    });
  }, []);

  return { tasks, error, refresh, upsertLocal };
}
