import { useEffect, useState } from "react";
import { createTask, updateTask, type TaskStatus } from "../api";
import { Sidebar } from "../components/Sidebar";
import { TaskView } from "../components/TaskView";
import { useTasks } from "../hooks/useTasks";

export interface TasksPageProps {
  readonly project: string;
}

export function TasksPage({ project }: TasksPageProps) {
  const { tasks, error, upsertLocal } = useTasks(project);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [project]);

  useEffect(() => {
    if (tasks && tasks.length > 0 && !tasks.some((task) => task.id === selectedId)) {
      setSelectedId(tasks[0].id);
    }
  }, [tasks, selectedId]);

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
