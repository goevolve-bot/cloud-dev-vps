import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  TASK_STATUSES,
  uploadAttachment,
  createComment,
  fetchTaskDetails,
  createRun,
  stopRun,
  answerQuestion,
  fetchProjectCosts,
  fetchProviders,
  type Task,
  type TaskStatus,
  type Comment as ApiComment,
  type TaskRun,
  type QueueRun,
  type Question,
  type Project,
  type ProviderInfo,
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

interface ArtifactsGalleryProps {
  readonly project: string;
  readonly taskId: number;
  readonly runNum: number;
}

function ArtifactsGallery({ project, taskId, runNum }: ArtifactsGalleryProps) {
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${project}/tasks/${taskId}/runs/${runNum}/artifacts`);
        if (res.ok) {
          const body = await res.json() as { artifacts: string[] };
          if (active) setArtifacts(body.artifacts || []);
        }
      } catch (err) {
        console.error("failed to load artifacts", err);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [project, taskId, runNum]);

  if (artifacts.length === 0) return null;

  return (
    <div className="artifacts-gallery-section" style={{ marginTop: 12 }}>
      <div className="muted small-label" style={{ marginBottom: 6 }}>VERIFICATION ARTIFACTS</div>
      <div className="artifacts-grid" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {artifacts.map((file) => {
          const url = `/api/projects/${project}/tasks/${taskId}/runs/${runNum}/artifacts/${encodeURIComponent(file)}`;
          const ext = file.split(".").pop()?.toLowerCase() || "";
          
          if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif") {
            return (
              <div
                key={file}
                className="artifact-item"
                style={{ cursor: "pointer", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden", width: 120, height: 90 }}
                onClick={() => setLightbox(url)}
              >
                <img
                  src={url}
                  alt={file}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  loading="lazy"
                />
              </div>
            );
          } else if (ext === "webm" || ext === "mp4") {
            return (
              <div
                key={file}
                className="artifact-item"
                style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden", width: 160, height: 90 }}
              >
                <video
                  src={url}
                  controls
                  muted
                  playsInline
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </div>
            );
          } else {
            return (
              <a
                key={file}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="chip"
                style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
              >
                🗎 {file}
              </a>
            );
          }
        })}
      </div>

      {lightbox && (
        <div
          className="lightbox-overlay"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.8)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 9999,
          }}
          onClick={() => setLightbox(null)}
        >
          <div style={{ position: "relative", maxWidth: "90%", maxHeight: "90%" }} onClick={(e) => e.stopPropagation()}>
            <img src={lightbox} alt="Lightbox View" style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }} />
            <button
              type="button"
              style={{
                position: "absolute",
                top: -30,
                right: 0,
                background: "none",
                border: "none",
                color: "white",
                fontSize: 20,
                cursor: "pointer",
              }}
              onClick={() => setLightbox(null)}
            >
              ✕ Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface InlineQuestionsProps {
  readonly questions: Question[];
  readonly onAnswer: (id: number, text: string) => Promise<void>;
}

function InlineQuestions({ questions, onAnswer }: InlineQuestionsProps) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState<Record<number, boolean>>({});

  if (questions.length === 0) return null;

  return (
    <div style={{
      marginTop: "10px",
      padding: "10px 15px",
      borderRadius: "6px",
      background: "var(--surface2)",
      border: "1px solid var(--border)",
    }}>
      <h5 style={{ margin: "0 0 10px 0", fontSize: "11px", fontWeight: "600", color: "var(--muted)", letterSpacing: "0.5px" }}>CLARIFICATION QUESTIONS</h5>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {questions.map((q) => {
          const draft = answers[q.id] ?? "";
          const isPending = !q.answer;
          const loading = submitting[q.id] || false;

          return (
            <li key={q.id} style={{ marginBottom: "12px", borderBottom: isPending ? "none" : "1px solid var(--border)", paddingBottom: isPending ? 0 : "8px" }}>
              <div style={{ fontWeight: "500", fontSize: "13px", marginBottom: "4px" }}>
                Q: {q.text}
              </div>
              {isPending ? (
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  <input
                    type="text"
                    placeholder="Provide your answer..."
                    value={draft}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                    style={{
                      flex: 1,
                      padding: "4px 8px",
                      borderRadius: "4px",
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--ink)",
                      fontSize: "12px",
                    }}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    className="chip solid"
                    style={{ fontSize: "11px", padding: "4px 10px" }}
                    onClick={async () => {
                      if (!draft.trim()) return;
                      setSubmitting({ ...submitting, [q.id]: true });
                      try {
                        await onAnswer(q.id, draft);
                      } finally {
                        setSubmitting({ ...submitting, [q.id]: false });
                      }
                    }}
                    disabled={loading || !draft.trim()}
                  >
                    {loading ? "Submitting..." : "Submit"}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: "12px", color: "var(--muted)", fontStyle: "italic", marginLeft: "10px" }}>
                  A: {q.answer} <span style={{ fontSize: "10px", color: "var(--muted)" }}>({new Date(q.answered_at!).toLocaleString()})</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface TaskViewProps {
  readonly task: Task;
  readonly project: string;
  readonly projectInfo?: Project;
  readonly onSave: (description: string) => Promise<void>;
  readonly onStatusChange: (status: TaskStatus) => Promise<void>;
}

export function TaskView({ task, project, projectInfo, onSave, onStatusChange }: TaskViewProps) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState(task.description);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { attachments, addLocal } = useAttachments(project, task.id);

  const [comments, setComments] = useState<ApiComment[]>([]);
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([]);
  const [queueRuns, setQueueRuns] = useState<QueueRun[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [plan, setPlan] = useState<string | null>(null);
  const [taskCostTotal, setTaskCostTotal] = useState<number | null>(null);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [runPhase, setRunPhase] = useState("implement");
  const [runProvider, setRunProvider] = useState(projectInfo?.defaultProvider ?? "claude");
  const [runModel, setRunModel] = useState(projectInfo?.defaultModel ?? "");
  const [runPrompt, setRunPrompt] = useState("");
  const [runningAction, setRunningAction] = useState(false);

  const [commentBody, setCommentBody] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);

  useEffect(() => {
    void fetchProviders()
      .then((data) => {
        setProviders(data);
        if (!runModel) {
          const firstModel = data.find((p) => p.id === runProvider)?.models[0];
          if (firstModel) setRunModel(firstModel.id);
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    async function loadDetails() {
      try {
        const details = await fetchTaskDetails(project, task.id);
        setComments(details.comments);
        setTaskRuns(details.runs);
        setQueueRuns(details.queueRuns);
        setQuestions(details.questions || []);
        setPlan(details.plan || null);
      } catch (err) {
        console.error("Failed to load details", err);
      }
    }
    async function loadCosts() {
      try {
        const costs = await fetchProjectCosts(project);
        const taskEntry = costs.taskTotals.find((t) => t.task_num === task.id);
        setTaskCostTotal(taskEntry?.total_usd ?? 0);
      } catch {
        // ignore
      }
    }
    void loadDetails();
    void loadCosts();

    const interval = setInterval(() => {
      void loadDetails();
      void loadCosts();
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
      setQuestions(details.questions || []);
      setPlan(details.plan || null);
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
      setQuestions(details.questions || []);
      setPlan(details.plan || null);
    } catch (err) {
      alert(`Failed to stop run: ${err}`);
    }
  }

  async function handleAnswerQuestion(questionId: number, answerText: string) {
    try {
      await answerQuestion(project, task.id, questionId, answerText);
      const details = await fetchTaskDetails(project, task.id);
      setComments(details.comments);
      setTaskRuns(details.runs);
      setQueueRuns(details.queueRuns);
      setQuestions(details.questions || []);
      setPlan(details.plan || null);
    } catch (err) {
      alert(`Failed to submit answer: ${err}`);
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
      <div className="trow-head" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <strong>
          #{task.id} {task.title}
        </strong>
        {taskCostTotal !== null && taskCostTotal > 0 && (
          <span className="chip" style={{ fontVariantNumeric: "tabular-nums", fontSize: 11 }}
            title="Total cost for this task">
            💰 ${taskCostTotal.toFixed(4)}
          </span>
        )}
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
        {task.status === "ready-for-review" && (
          <button
            type="button"
            className="chip solid"
            style={{ background: "#0f766e", color: "#fff", fontWeight: "600" }}
            onClick={() => void onStatusChange("done")}
          >
            Accept Task
          </button>
        )}
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
                <option value="verify">Verify</option>
                <option value="review">Review</option>
              </select>
            </label>
            <label>
              Provider:
              <select
                value={runProvider}
                onChange={(e) => {
                  const newProvider = e.target.value;
                  setRunProvider(newProvider);
                  // Reset the model to the new provider's first model — the
                  // old model id is almost certainly invalid for it.
                  const firstModel = providers.find((p) => p.id === newProvider)?.models[0];
                  setRunModel(firstModel?.id ?? "");
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model:
              <select value={runModel} onChange={(e) => setRunModel(e.target.value)}>
                {(providers.find((p) => p.id === runProvider)?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
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
            {/* Quick actions launch with whatever provider/model is currently
                selected above, just overriding the phase — they used to hardcode
                a provider/model pair that went stale the moment the model
                catalog changed. */}
            <button type="button" className="chip" onClick={() => void launchRun("plan")}>
              Plan
            </button>
            <button type="button" className="chip" onClick={() => void launchRun("implement")}>
              Implement
            </button>
            <button type="button" className="chip" onClick={() => void launchRun("verify")}>
              Verify
            </button>
            <button type="button" className="chip" onClick={() => void launchRun("review")}>
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

      {/* PLAN */}
      {plan && (
        <div className="desc" style={{ marginTop: "15px" }}>
          <div className="desc-head">
            <span className="muted small-label">IMPLEMENTATION PLAN</span>
          </div>
          <div style={{ padding: "10px 15px", background: "var(--surface)" }}>
            <Markdown text={plan} />
          </div>
        </div>
      )}

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
            // task_runs.run_num is forced to equal the runtime runs.id (queue.ts
            // passes { num: run.id } to addRunOutcome), so this is an exact
            // identity match rather than a (phase, started_at) heuristic that
            // could collide on same-millisecond starts or a null started_at.
            const matchedQueueRun = queueRuns.find((q) => q.id === r.run_num);
            const runQuestions = matchedQueueRun
              ? questions.filter((qn) => qn.run_id === matchedQueueRun.id)
              : [];

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
                  {r.phase === "verify" && (
                    <ArtifactsGallery project={project} taskId={task.id} runNum={r.run_num} />
                  )}
                  {runQuestions.length > 0 && (
                    <InlineQuestions questions={runQuestions} onAnswer={handleAnswerQuestion} />
                  )}
                </div>
              </div>
            );
          } else {
            const q = item.data as QueueRun;
            // Only render queueRun if it's not yet completed (running/queued/cancelled/interrupted),
            // or if it doesn't exist in taskRuns to avoid duplication. Matched by
            // identity (run_num === runs.id) rather than (phase, started_at) —
            // see the "run" branch above.
            const existsInTaskRuns = taskRuns.some((tr) => tr.run_num === q.id);
            if (existsInTaskRuns && q.status !== "running" && q.status !== "queued") {
              return null;
            }

            const runQuestions = questions.filter((qn) => qn.run_id === q.id);

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
                  {runQuestions.length > 0 && (
                    <InlineQuestions questions={runQuestions} onAnswer={handleAnswerQuestion} />
                  )}
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
