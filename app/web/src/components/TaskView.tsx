import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { TASK_STATUSES, uploadAttachment, type Task, type TaskStatus } from "../api";
import { useAttachments } from "../hooks/useAttachments";
import { AttachmentsBar } from "./AttachmentsBar";
import { Markdown } from "./Markdown";

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "todo",
  "in-progress": "in progress",
  "ready-for-review": "ready for review",
  done: "done",
  blocked: "blocked",
};

// Above this, a text paste becomes a pasted-NN.md attachment instead of
// landing inline — mirrors how Claude's chat composer handles big pastes.
const LARGE_PASTE_THRESHOLD = 400;

export interface TaskViewProps {
  readonly task: Task;
  readonly project: string;
  readonly onSave: (description: string) => Promise<void>;
  readonly onStatusChange: (status: TaskStatus) => Promise<void>;
}

export function TaskView({ task, project, onSave, onStatusChange }: TaskViewProps) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState(task.description);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { attachments, addLocal } = useAttachments(project, task.id);

  useEffect(() => {
    setDraft(task.description);
    setMode("preview");
  }, [task.id, task.description]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await onSave(draft);
      setMode("preview");
    } finally {
      setSaving(false);
    }
  }

  function insertAtCursor(text: string): void {
    const el = textareaRef.current;
    if (!el) {
      setDraft((current) => current + text);
      return;
    }
    const { selectionStart, selectionEnd } = el;
    setDraft((current) => current.slice(0, selectionStart) + text + current.slice(selectionEnd));
    const caret = selectionStart + text.length;
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
      el.focus();
    });
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/"),
    );
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      const filename = await uploadAttachment(project, task.id, {
        contentType: file.type,
        data: file,
      });
      addLocal(filename);
      insertAtCursor(`![${filename}](attachments/${filename})\n`);
      return;
    }

    const text = event.clipboardData.getData("text/plain");
    if (text.length > LARGE_PASTE_THRESHOLD) {
      event.preventDefault();
      const filename = await uploadAttachment(project, task.id, {
        contentType: "text/plain",
        data: text,
      });
      addLocal(filename);
      insertAtCursor(`[${filename}](attachments/${filename})\n`);
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
            ref={textareaRef}
            className="desc-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => void handlePaste(event)}
            rows={10}
            aria-label="description"
          />
        )}
        <AttachmentsBar
          project={project}
          taskId={task.id}
          attachments={attachments}
          onUploaded={addLocal}
        />
      </div>
    </main>
  );
}
