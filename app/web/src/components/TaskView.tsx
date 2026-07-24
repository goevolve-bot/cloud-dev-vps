import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  TASK_STATUSES,
  uploadAttachment,
  createComment,
  fetchTaskDetails,
  createRun,
  stopRun,
  type Task,
  type TaskStatus,
  type Comment as ApiComment,
  type TaskRun,
  type QueueRun,
} from "../api";
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

interface LiveLogsProps {
  readonly runId: number;
}

function LiveLogs({ runId }: LiveLogsProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogs([]);
    const source = new EventSource(`/api/runs/${runId}/events`);

    source.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "log") {
          setLogs((current) => [...current, msg.line]);
        }
      } catch (err) {
        console.error("Failed to parse event", err);
      }
    });

    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, [runId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="logs-container mono small">
      {logs.map((line, idx) => (
        <div key={idx} className="log-line">
          {line}
        </div>
      ))}
      <div ref={logEndRef} />
    </div>
  );
}

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

  const [comments, setComments] = useState<ApiComment[]>([]);
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([]);
  const [queueRuns, setQueueRuns] = useState<QueueRun[]>([]);

  const [runPhase, setRunPhase] = useState("implement");
  const [runProvider, setRunProvider] = useState("claude");
  const [runModel, setRunModel] = useState("claude-3-5-sonnet-latest");
  const [runPrompt, setRunPrompt] = useState("");
  const [runningAction, setRunningAction] = useState(false);

  const [commentBody, setCommentBody] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);

  useEffect(() => {
    async function loadDetails() {
      try {
        const details = await fetchTaskDetails(project, task.id);
        setComments(details.comments);
        setTaskRuns(details.runs);
        setQueueRuns(details.queueRuns);
      } catch (err) {
        console.error("Failed to load details", err);
      }
    }
    void loadDetails();

    const interval = setInterval(() => {
      void loadDetails();
    }, 3000);
    return () => clearInterval(interval);
  }, [project, task.id]);

  async function launchRun(
    phase = runPhase,
    provider = runProvider,
    model = runModel,
    prompt = runPrompt,
  ): Promise<void> {
    setRunningAction(true);
    try {
      await createRun(project, task.id, { phase, provider, model, prompt });
      const details = await fetchTaskDetails(project, task.id);
      setComments(details.comments);
      setTaskRuns(details.runs);
      setQueueRuns(details.queueRuns);
    } catch (err) {
      alert(`Failed to launch run: ${err}`);
    } finally {
      setRunningAction(false);
    }
  }

  async function handleStopRun(runId: number): Promise<void> {
    try {
      await stopRun(runId);
      const details = await fetchTaskDetails(project, task.id);
      setComments(details.comments);
      setTaskRuns(details.runs);
      setQueueRuns(details.queueRuns);
    } catch (err) {
      alert(`Failed to stop run: ${err}`);
    }
  }

  async function handleAddComment(): Promise<void> {
    if (!commentBody.trim()) return;
    setSubmittingComment(true);
    try {
      const updatedComments = await createComment(project, task.id, { body: commentBody });
      setComments(updatedComments);
      setCommentBody("");
    } catch (err) {
      alert(`Failed to add comment: ${err}`);
    } finally {
      setSubmittingComment(false);
    }
  }

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

  const timelineItems = [
    ...comments.map((c) => ({ type: "comment" as const, date: c.created_at, data: c })),
    ...taskRuns.map((r) => ({ type: "run" as const, date: r.started_at || r.finished_at || "", data: r })),
    ...queueRuns.map((q) => ({ type: "queueRun" as const, date: q.created_at || q.started_at || "", data: q })),
  ];
  timelineItems.sort((a, b) => a.date.localeCompare(b.date));

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

      {/* LAUNCH BAR */}
      <div className="launch-bar desc">
        <div className="desc-head">
          <span className="muted small-label">LAUNCH AGENT RUN</span>
        </div>
        <div className="launch-bar-controls">
          <div className="launch-bar-row">
            <label>
              Phase:
              <select value={runPhase} onChange={(e) => setRunPhase(e.target.value)}>
                <option value="interview">Interview</option>
                <option value="refine">Refine</option>
                <option value="plan">Plan</option>
                <option value="implement">Implement</option>
                <option value="review">Review</option>
              </select>
            </label>
            <label>
              Provider:
              <select value={runProvider} onChange={(e) => setRunProvider(e.target.value)}>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label>
              Model:
              <select value={runModel} onChange={(e) => setRunModel(e.target.value)}>
                <option value="claude-3-5-sonnet-latest">Claude 3.5 Sonnet</option>
                <option value="claude-3-5-haiku-latest">Claude 3.5 Haiku</option>
                <option value="claude-3-opus-latest">Claude 3 Opus</option>
              </select>
            </label>
            <button
              type="button"
              className="chip solid btn-run"
              onClick={() => void launchRun()}
              disabled={runningAction}
            >
              {runningAction ? "Launching..." : "Run"}
            </button>
          </div>
          <div className="launch-bar-prompt">
            <input
              type="text"
              className="prompt-input"
              value={runPrompt}
              onChange={(e) => setRunPrompt(e.target.value)}
              placeholder="Custom instructions (optional)..."
              aria-label="prompt"
            />
          </div>
          <div className="launch-bar-quick">
            <span className="small-label muted">Quick Actions:</span>
            <button
              type="button"
              className="chip"
              onClick={() => void launchRun("plan", "claude", "claude-3-5-sonnet-latest")}
            >
              Plan
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => void launchRun("implement", "claude", "claude-3-5-sonnet-latest")}
            >
              Implement
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => void launchRun("review", "claude", "claude-3-5-sonnet-latest")}
            >
              Review
            </button>
          </div>
        </div>
      </div>

      {/* DESCRIPTION */}
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

      {/* TIMELINE */}
      <div className="timeline">
        <span className="muted small-label">TIMELINE</span>
        {timelineItems.map((item, index) => {
          if (item.type === "comment") {
            const c = item.data as ApiComment;
            return (
              <div key={`c-${c.id}-${index}`} className="timeline-entry comment">
                <div className="timeline-entry-header">
                  <span className="timeline-entry-author">
                    {c.author || "Anonymous Commenter"}
                  </span>
                  <span>{new Date(c.created_at).toLocaleString()}</span>
                </div>
                <div className="timeline-entry-body">
                  <Markdown text={c.body} />
                </div>
              </div>
            );
          } else if (item.type === "run") {
            const r = item.data as TaskRun;
            return (
              <div key={`r-${r.id}-${index}`} className="timeline-entry run">
                <div className="timeline-entry-header">
                  <span>
                    Run #{r.run_num} ({r.phase}) Finished at{" "}
                    {r.finished_at ? new Date(r.finished_at).toLocaleString() : "unknown"}
                  </span>
                  <span className={`run-chip ${r.status || ""}`}>{r.status}</span>
                </div>
                <div className="timeline-entry-body">
                  <div className="muted small-label" style={{ marginBottom: 4 }}>
                    Cost: ${r.cost_usd || 0} • Input: {r.tokens_in || 0} • Output:{" "}
                    {r.tokens_out || 0}
                  </div>
                  <Markdown text={r.outcome} />
                </div>
              </div>
            );
          } else {
            const q = item.data as QueueRun;
            // Only render queueRun if it's not yet completed (running/queued/cancelled/interrupted),
            // or if it doesn't exist in taskRuns to avoid duplication
            const existsInTaskRuns = taskRuns.some(
              (tr) => tr.phase === q.phase && tr.started_at === q.started_at,
            );
            if (existsInTaskRuns && q.status !== "running" && q.status !== "queued") {
              return null;
            }

            return (
              <div key={`q-${q.id}-${index}`} className="timeline-entry run">
                <div className="timeline-entry-header">
                  <span>
                    Agent Run ({q.phase}) Started:{" "}
                    {q.started_at ? new Date(q.started_at).toLocaleString() : "pending"}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`run-chip ${q.status}`}>{q.status}</span>
                    {(q.status === "running" || q.status === "queued") && (
                      <button
                        type="button"
                        className="chip"
                        style={{ fontSize: 10, padding: "2px 4px" }}
                        onClick={() => void handleStopRun(q.id)}
                      >
                        Stop
                      </button>
                    )}
                  </div>
                </div>
                <div className="timeline-entry-body">
                  {q.prompt && (
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      Prompt: {q.prompt}
                    </div>
                  )}
                  {q.status === "running" && <LiveLogs runId={q.id} />}
                </div>
              </div>
            );
          }
        })}

        {/* COMMENT COMPOSER */}
        <div className="comment-composer">
          <span className="muted small-label">ADD COMMENT</span>
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder="Write a comment..."
            rows={3}
            aria-label="comment text"
          />
          <button
            type="button"
            className="chip solid"
            style={{ width: "fit-content", alignSelf: "flex-end" }}
            onClick={() => void handleAddComment()}
            disabled={submittingComment}
          >
            {submittingComment ? "Posting..." : "Post Comment"}
          </button>
        </div>
      </div>
    </main>
  );
}
