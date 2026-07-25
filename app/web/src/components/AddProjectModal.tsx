import { useState } from "react";
import { createProject, type CreateProjectEvent, type Project } from "../api";

interface AddProjectModalProps {
  readonly onClose: () => void;
  readonly onCreated: (project: Project) => void;
}

interface ProgressLine {
  readonly step: string;
  readonly message: string;
}

const PANEL: React.CSSProperties = {
  background: "var(--surface2)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  width: 560,
  maxHeight: "80vh",
  overflowY: "auto",
  padding: 24,
};

const FIELD: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: 13,
};

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,27}[a-z0-9])?$/;

/**
 * Two steps, because `create` has two happy endings. The first submit runs
 * until the clone; if the deploy key has not been authorized on the repo yet
 * the server answers `awaiting-key` with the public key, and the same input
 * is submitted again once the user has added it — `create` is idempotent and
 * picks up where it stopped.
 */
export function AddProjectModal({ onClose, onCreated }: AddProjectModalProps) {
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nameValid = NAME_RE.test(name);
  const canSubmit = nameValid && gitUrl.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setPublicKey(null);
    setProgress([]);
    try {
      const terminal = await createProject(
        { name, gitUrl: gitUrl.trim() },
        (event: CreateProjectEvent) => {
          if (event.type === "progress") {
            setProgress((lines) => [...lines, { step: event.step, message: event.message }]);
          }
        },
      );
      if (terminal.type === "ready") {
        onCreated(terminal.project);
        return;
      }
      if (terminal.type === "awaiting-key") {
        setPublicKey(terminal.publicKey);
        setCopied(false);
        return;
      }
      setError(terminal.type === "error" ? (terminal.message ?? terminal.code) : "unexpected end");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={busy ? undefined : onClose}
    >
      <div className="modal-panel" style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 20,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Add project</h2>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
            aria-label="close add project"
            style={{ fontSize: 18 }}
          >
            ✕
          </button>
        </div>

        {!publicKey && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label
                htmlFor="add-project-name"
                style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}
              >
                NAME
              </label>
              <input
                id="add-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                placeholder="my-app"
                style={FIELD}
              />
              {name && !nameValid && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Lowercase letters, digits and dashes; must start and end
                  alphanumeric; 29 characters max.
                </div>
              )}
            </div>
            <div>
              <label
                htmlFor="add-project-url"
                style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}
              >
                GIT URL
              </label>
              <input
                id="add-project-url"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                disabled={busy}
                placeholder="git@github.com:you/my-app.git"
                style={{ ...FIELD, fontFamily: "monospace" }}
              />
            </div>
            <button
              type="button"
              className="chip solid"
              onClick={() => void submit()}
              disabled={!canSubmit}
              style={{ alignSelf: "flex-start" }}
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        )}

        {publicKey && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13 }}>
              Add this deploy key to <span className="mono">{gitUrl}</span> with{" "}
              <strong>write access</strong>, then continue. pm needs to push{" "}
              <span className="mono">.pm/</span> and task branches, so a read-only key
              will not do.
            </p>
            <textarea
              readOnly
              value={publicKey}
              rows={3}
              aria-label="deploy public key"
              style={{ ...FIELD, fontFamily: "monospace", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button type="button" className="chip" onClick={() => void copyKey()}>
                {copied ? "Copied" : "Copy key"}
              </button>
              <button
                type="button"
                className="chip solid"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy ? "Continuing…" : "Done, continue"}
              </button>
            </div>
          </div>
        )}

        {progress.length > 0 && (
          <div
            className="mono"
            style={{
              marginTop: 16,
              fontSize: 11,
              maxHeight: 160,
              overflowY: "auto",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "8px 10px",
            }}
          >
            {progress.map((line, index) => (
              <div key={`${line.step}-${index}`}>
                <span className="muted">{line.step}</span> {line.message}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--red, #ef4444)" }}>{error}</div>
        )}
      </div>
    </div>
  );
}
