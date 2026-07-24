import { useState, type FormEvent } from "react";
import { TASK_STATUSES, type Task, type TaskStatus } from "../api";

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "todo",
  "in-progress": "in progress",
  "ready-for-review": "ready for review",
  done: "done",
  blocked: "blocked",
};

const DEFAULT_COLLAPSED: Record<TaskStatus, boolean> = {
  todo: false,
  "in-progress": false,
  "ready-for-review": false,
  done: true,
  blocked: false,
};

export interface SidebarProps {
  readonly tasks: readonly Task[];
  readonly selectedId: number | null;
  readonly onSelect: (id: number) => void;
  readonly onNewTask: (title: string) => void;
}

export function Sidebar({ tasks, selectedId, onSelect, onNewTask }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<TaskStatus, boolean>>(DEFAULT_COLLAPSED);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");

  function submitNewTask(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onNewTask(trimmed);
    setTitle("");
    setCreating(false);
  }

  return (
    <aside className="side">
      <div className="side-new">
        {creating ? (
          <form onSubmit={submitNewTask} className="new-task-form">
            <input
              autoFocus
              className="search"
              placeholder="task title…"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" className="btn primary">
              add
            </button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              cancel
            </button>
          </form>
        ) : (
          <button type="button" className="btn new-task-btn" onClick={() => setCreating(true)}>
            + new task
          </button>
        )}
      </div>
      {TASK_STATUSES.map((status) => {
        const items = tasks.filter((task) => task.status === status);
        return (
          <div className="group" key={status}>
            <button
              type="button"
              className="ghead"
              onClick={() =>
                setCollapsed((current) => ({ ...current, [status]: !current[status] }))
              }
            >
              <span>
                {collapsed[status] ? "▸" : "▾"} {STATUS_LABELS[status]}
              </span>
              <span className="muted">{items.length}</span>
            </button>
            {!collapsed[status] &&
              items.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className={`trow${task.id === selectedId ? " on" : ""}`}
                  onClick={() => onSelect(task.id)}
                >
                  <span className="id">#{task.id}</span>
                  <span className="t">{task.title}</span>
                </button>
              ))}
          </div>
        );
      })}
    </aside>
  );
}
