import { useEffect, useState } from "react";
import {
  fetchProviders,
  connectProvider,
  updateProjectDefaults,
  setProjectLifecycle,
  type ProviderInfo,
  type Project,
} from "../api";

interface SettingsModalProps {
  readonly currentProject: Project | undefined;
  readonly onClose: () => void;
  readonly onProjectUpdated: () => void;
}

export function SettingsModal({ currentProject, onClose, onProjectUpdated }: SettingsModalProps) {
  const [tab, setTab] = useState<"providers" | "project">("providers");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [apiKey, setApiKey] = useState<Record<string, string>>({});
  const [connecting, setConnecting] = useState<Record<string, boolean>>({});
  const [connectMsg, setConnectMsg] = useState<Record<string, string>>({});
  const [connectFailed, setConnectFailed] = useState<Record<string, boolean>>({});
  const [defProvider, setDefProvider] = useState(currentProject?.defaultProvider ?? "claude");
  const [defModel, setDefModel] = useState(currentProject?.defaultModel ?? "");
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [togglingAlwaysOn, setTogglingAlwaysOn] = useState(false);

  // Models come exclusively from the fetched providers — each adapter's
  // models() is the single source of truth, not a copy baked into the UI.
  const availableModels = providers.find((p) => p.id === defProvider)?.models ?? [];

  useEffect(() => {
    void fetchProviders()
      .then((data) => {
        setProviders(data);
        // No default picked yet (new project, or nothing saved): fall back to
        // the current provider's first model once the real list has loaded.
        if (!defModel) {
          const firstModel = data.find((p) => p.id === defProvider)?.models[0];
          if (firstModel) setDefModel(firstModel.id);
        }
      })
      .catch(console.error);
  }, []);

  // Sync defaults from project
  useEffect(() => {
    if (currentProject) {
      setDefProvider(currentProject.defaultProvider ?? "claude");
      setDefModel(currentProject.defaultModel ?? "");
    }
  }, [currentProject]);

  async function handleConnect(providerId: string) {
    const key = apiKey[providerId] ?? "";
    if (!key.trim()) return;
    setConnecting((c) => ({ ...c, [providerId]: true }));
    setConnectMsg((m) => ({ ...m, [providerId]: "" }));
    setConnectFailed((f) => ({ ...f, [providerId]: false }));
    try {
      const result = await connectProvider(providerId, { type: "api-key", key });
      if (result.ok) {
        // Zero projects still counts: the key is stored and every project
        // created from here on is seeded with it.
        const scope =
          result.projectsUpdated === 0
            ? "no projects yet — it will be added to the first one you create"
            : `written to ${result.projectsUpdated} project${result.projectsUpdated === 1 ? "" : "s"}`;
        setConnectMsg((m) => ({ ...m, [providerId]: `Connected (${result.maskedKey}) — ${scope}` }));
        setApiKey((k) => ({ ...k, [providerId]: "" }));
      } else {
        // The key did not reach every project, so the provider stays
        // disconnected. Keep the field filled so a retry is one click.
        const which = (result.failures ?? [])
          .map((f) => `${f.project}: ${f.message ?? "failed"}`)
          .join("; ");
        setConnectMsg((m) => ({
          ...m,
          [providerId]: `Not connected — ${result.message ?? "delivery failed"}${which ? ` (${which})` : ""}`,
        }));
        setConnectFailed((f) => ({ ...f, [providerId]: true }));
      }
      const updated = await fetchProviders();
      setProviders(updated);
    } catch (err) {
      setConnectMsg((m) => ({ ...m, [providerId]: String(err) }));
      setConnectFailed((f) => ({ ...f, [providerId]: true }));
    } finally {
      setConnecting((c) => ({ ...c, [providerId]: false }));
    }
  }

  async function handleSaveDefaults() {
    if (!currentProject) return;
    setSavingDefaults(true);
    try {
      await updateProjectDefaults(currentProject.name, { provider: defProvider, model: defModel });
      onProjectUpdated();
    } catch (err) {
      alert(String(err));
    } finally {
      setSavingDefaults(false);
    }
  }

  async function handleToggleAlwaysOn() {
    if (!currentProject) return;
    setTogglingAlwaysOn(true);
    try {
      await setProjectLifecycle(currentProject.name, "set-always-on", !currentProject.alwaysOn);
      onProjectUpdated();
    } catch (err) {
      alert(String(err));
    } finally {
      setTogglingAlwaysOn(false);
    }
  }

  async function handleLifecycle(action: "start" | "stop") {
    if (!currentProject) return;
    try {
      await setProjectLifecycle(currentProject.name, action);
      onProjectUpdated();
    } catch (err) {
      alert(String(err));
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
      onClick={onClose}
    >
      <div
        className="modal-panel"
        style={{
          background: "var(--surface2)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          width: 560,
          maxHeight: "80vh",
          overflowY: "auto",
          padding: "24px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Settings</h2>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="close settings"
            style={{ fontSize: 18 }}
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)" }}>
          {(["providers", "project"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tab${tab === t ? " on" : ""}`}
              onClick={() => setTab(t)}
              style={{ textTransform: "capitalize", paddingBottom: 8 }}
            >
              {t === "project" ? "Project Defaults" : "Providers"}
            </button>
          ))}
        </div>

        {/* Providers tab */}
        {tab === "providers" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {providers.length === 0 && (
              <p className="muted" style={{ fontSize: 13 }}>Loading providers…</p>
            )}
            {providers.map((p) => (
              <div
                key={p.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "14px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      Auth: {p.authType}
                    </div>
                  </div>
                  <span
                    className={`chip ${p.connected ? "compliant" : "non-compliant"}`}
                    style={{ fontSize: 11 }}
                  >
                    {p.connected ? "✓ connected" : "✗ not connected"}
                  </span>
                </div>

                {p.connected && p.maskedKey && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                    Key: <span className="mono">{p.maskedKey}</span>
                    {p.connectedAt && (
                      <> · Added {new Date(p.connectedAt).toLocaleDateString()}</>
                    )}
                  </div>
                )}

                {p.authType === "api-key" && (
                  <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                    <input
                      type="password"
                      placeholder={`Paste ${p.name} API key…`}
                      value={apiKey[p.id] ?? ""}
                      onChange={(e) => setApiKey((k) => ({ ...k, [p.id]: e.target.value }))}
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        color: "var(--ink)",
                        fontSize: 13,
                        fontFamily: "monospace",
                      }}
                      aria-label={`${p.name} API key`}
                    />
                    <button
                      type="button"
                      className="chip solid"
                      disabled={connecting[p.id] || !apiKey[p.id]?.trim()}
                      onClick={() => void handleConnect(p.id)}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {connecting[p.id] ? "Connecting…" : p.connected ? "Update Key" : "Connect"}
                    </button>
                  </div>
                )}

                {p.authType === "oauth" && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                    Antigravity uses the <span className="mono">agy</span> CLI auth. Log in via{" "}
                    <span className="mono">agy auth login</span> on the VPS.
                  </div>
                )}

                {connectMsg[p.id] && (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: connectFailed[p.id] ? "var(--red, #ef4444)" : "var(--accent)",
                    }}
                  >
                    {connectMsg[p.id]}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Project defaults tab */}
        {tab === "project" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {!currentProject ? (
              <p className="muted">No project selected.</p>
            ) : (
              <>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
                    DEFAULT PROVIDER
                  </label>
                  <select
                    value={defProvider}
                    onChange={(e) => {
                      setDefProvider(e.target.value);
                      const firstModel = providers.find((p) => p.id === e.target.value)?.models[0];
                      if (firstModel) setDefModel(firstModel.id);
                    }}
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--ink)",
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
                    DEFAULT MODEL
                  </label>
                  <select
                    value={defModel}
                    onChange={(e) => setDefModel(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--ink)",
                    }}
                  >
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="chip solid"
                  onClick={() => void handleSaveDefaults()}
                  disabled={savingDefaults}
                  style={{ alignSelf: "flex-start" }}
                >
                  {savingDefaults ? "Saving…" : "Save Defaults"}
                </button>

                <hr style={{ border: "none", borderTop: "1px solid var(--border)" }} />

                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
                    LIFECYCLE
                  </label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className={`chip ${currentProject.lifecycle === "active" ? "compliant" : ""}`}>
                      {currentProject.lifecycle}
                    </span>
                    <button
                      type="button"
                      className="chip solid"
                      onClick={() => void handleLifecycle("start")}
                      disabled={currentProject.lifecycle === "active"}
                    >
                      Start
                    </button>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => void handleLifecycle("stop")}
                      disabled={currentProject.lifecycle === "stopped"}
                    >
                      Stop
                    </button>
                    <button
                      type="button"
                      className={`chip${currentProject.alwaysOn ? " solid" : ""}`}
                      onClick={() => void handleToggleAlwaysOn()}
                      disabled={togglingAlwaysOn}
                      title="Always-on projects are never idle-stopped"
                    >
                      {currentProject.alwaysOn ? "📌 Always On" : "Pin Always On"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
