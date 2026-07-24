import { useEffect, useState } from "react";
import { createTask, fetchProjects, updateTask, type Project, type TaskStatus } from "../api";
import { Sidebar } from "../components/Sidebar";
import { TaskView } from "../components/TaskView";
import { useTasks } from "../hooks/useTasks";

export interface TasksPageProps {
  readonly project: string;
}

export function TasksPage({ project }: TasksPageProps) {
  const { tasks, error, upsertLocal } = useTasks(project);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [projectInfo, setProjectInfo] = useState<Project | undefined>(undefined);

  useEffect(() => {
    setSelectedId(null);
  }, [project]);

  useEffect(() => {
    if (tasks && tasks.length > 0 && !tasks.some((task) => task.id === selectedId)) {
      setSelectedId(tasks[0].id);
    }
  }, [tasks, selectedId]);

  // Fetch project info for defaults (T36/T37)
  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((all) => {
        if (!cancelled) setProjectInfo(all.find((p) => p.name === project));
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [project]);

  if (error) return <div className="empty-state">Could not load tasks: {error}</div>;
  if (!tasks) return <div className="empty-state">Loading tasks…</div>;

  const selected = tasks.find((task) => task.id === selectedId) ?? null;

  async function handleNewTask(title: string): Promise<void> {
    const task = await createTask(project, { title, description: "" });
    upsertLocal(task);
    setSelectedId(task.id);
  }

  async function handleSaveDescription(description: string): Promise<void> {
    if (!selected) return;
    const updated = await updateTask(project, selected.id, { description });
    upsertLocal(updated);
  }

  async function handleStatusChange(status: TaskStatus): Promise<void> {
    if (!selected) return;
    const updated = await updateTask(project, selected.id, { status });
    upsertLocal(updated);
  }

  return (
    <div className="desk">
      <Sidebar
        tasks={tasks}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNewTask={(title) => void handleNewTask(title)}
      />
      {selected ? (
        <TaskView
          task={selected}
          project={project}
          projectInfo={projectInfo}
          onSave={handleSaveDescription}
          onStatusChange={handleStatusChange}
        />
      ) : (
        <main className="main">
          <div className="empty-state">No tasks yet — create one.</div>
        </main>
      )}
    </div>
  );
}
