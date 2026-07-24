import { useEffect, useState } from "react";
import { TASK_STATUSES, type Task, type TaskStatus } from "../api";
import { Markdown } from "./Markdown";

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "todo",
  "in-progress": "in progress",
  "ready-for-review": "ready for review",
  done: "done",
  blocked: "blocked",
};

export interface TaskViewProps {
  readonly task: Task;
  readonly onSave: (description: string) => Promise<void>;
  readonly onStatusChange: (status: TaskStatus) => Promise<void>;
}

export function TaskView({ task, onSave, onStatusChange }: TaskViewProps) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState(task.description);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(task.description);
    setMode("preview");
  }, [task.id, task.description]);

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
      setMode("preview");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="main">
      <div className="trow-head">
        <strong>
          #{task.id} {task.title}
        </strong>
        <select
          className="project-select"
          value={task.status}
          onChange={(event) => void onStatusChange(event.target.value as TaskStatus)}
          aria-label="status"
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        {task.branch && <span className="chip mono">{task.branch}</span>}
      </div>
      <div className="desc">
        <div className="desc-head">
          <span className="muted small-label">DESCRIPTION</span>
          <span className="spacer" />
          {mode === "preview" ? (
            <button type="button" className="chip" onClick={() => setMode("edit")}>
              edit
            </button>
          ) : (
            <>
              <button
                type="button"
                className="chip solid"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? "saving…" : "save"}
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setDraft(task.description);
                  setMode("preview");
                }}
              >
                cancel
              </button>
            </>
          )}
        </div>
        {mode === "preview" ? (
          <Markdown text={task.description || "*No description yet.*"} />
        ) : (
          <textarea
            className="desc-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={10}
            aria-label="description"
          />
        )}
      </div>
    </main>
  );
}
