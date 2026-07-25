import { useEffect, useState } from "react";
import { fetchAdrs, fetchProjects, type Adr } from "../api";
import { Markdown } from "../components/Markdown";

export interface AdrsPageProps {
  readonly project: string;
}

export function AdrsPage({ project }: AdrsPageProps) {
  const [adrs, setAdrs] = useState<Adr[] | null>(null);
  const [selectedAdr, setSelectedAdr] = useState<Adr | null>(null);
  const [gitUrl, setGitUrl] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        const [adrsList, projectsList] = await Promise.all([
          fetchAdrs(project),
          fetchProjects(),
        ]);
        setAdrs(adrsList);
        if (adrsList.length > 0) {
          setSelectedAdr(adrsList[0]);
        } else {
          setSelectedAdr(null);
        }
        const proj = projectsList.find((p) => p.name === project);
        setGitUrl(proj?.gitUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load ADRs.");
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [project]);

  function getGitHistoryUrl(adrPath: string): string | null {
    if (!gitUrl) return null;
    const match = adrPath.match(/\.pm\/adrs\/[^/]+$/);
    const repoPath = match ? match[0] : adrPath;

    let webUrl = gitUrl;
    if (webUrl.startsWith("git@github.com:")) {
      webUrl = webUrl.replace("git@github.com:", "https://github.com/");
    } else if (webUrl.startsWith("git@github.com/")) {
      webUrl = webUrl.replace("git@github.com/", "https://github.com/");
    }
    if (webUrl.endsWith(".git")) {
      webUrl = webUrl.slice(0, -4);
    }
    return `${webUrl}/commits/main/${repoPath}`;
  }

  function renderStatusBadge(status: Adr["status"]) {
    let color = "var(--ink)";
    let bg = "var(--border)";
    if (status === "accepted") {
      color = "#0f766e";
      bg = "rgba(15, 118, 110, 0.1)";
    } else if (status === "superseded") {
      color = "#c2410c";
      bg = "rgba(194, 65, 12, 0.1)";
    } else if (status === "abandoned") {
      color = "#be123c";
      bg = "rgba(190, 18, 60, 0.1)";
    }

    return (
      <span
        style={{
          fontSize: "10px",
          fontWeight: "600",
          textTransform: "uppercase",
          padding: "2px 6px",
          borderRadius: "4px",
          color,
          background: bg,
        }}
      >
        {status}
      </span>
    );
  }

  if (loading) {
    return <div className="empty-state">Loading ADRs…</div>;
  }

  if (error) {
    return <div className="empty-state">Error: {error}</div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", flex: 1, overflow: "hidden" }}>
      <div style={{ borderRight: "1px solid var(--border)", background: "var(--surface)", overflowY: "auto", padding: "10px" }}>
        <h4 style={{ margin: "0 0 10px 0", color: "var(--muted)", textTransform: "uppercase", fontSize: "11px", letterSpacing: "0.5px" }}>ADRs</h4>
        {adrs && adrs.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {adrs.map((adr) => {
              const active = selectedAdr?.id === adr.id;
              const isAbandoned = adr.status === "abandoned";
              return (
                <li key={adr.id} style={{ marginBottom: "4px" }}>
                  <button
                    onClick={() => setSelectedAdr(adr)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "4px",
                      width: "100%",
                      padding: "8px",
                      borderRadius: "4px",
                      background: active ? "var(--accent-soft)" : "transparent",
                      color: active ? "var(--accent)" : "var(--ink)",
                      fontSize: "13px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: "600" }}>ADR #{String(adr.id).padStart(4, "0")}</span>
                      {renderStatusBadge(adr.status)}
                    </div>
                    <span style={{
                      textAlign: "left",
                      textDecoration: isAbandoned ? "line-through" : "none",
                      color: isAbandoned ? "var(--muted)" : "inherit",
                    }}>
                      {adr.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div style={{ color: "var(--muted)", fontStyle: "italic", fontSize: "12px" }}>No ADRs found.</div>
        )}
      </div>

      <div style={{ overflowY: "auto", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
        {selectedAdr ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 20px",
              background: "var(--surface)",
              borderBottom: "1px solid var(--border)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <h2 style={{ margin: 0, fontSize: "16px", fontWeight: "600" }}>ADR #{String(selectedAdr.id).padStart(4, "0")}</h2>
                {renderStatusBadge(selectedAdr.status)}
              </div>
              {getGitHistoryUrl(selectedAdr.path) && (
                <a
                  href={getGitHistoryUrl(selectedAdr.path)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: "12px",
                    color: "var(--accent)",
                    textDecoration: "none",
                    padding: "4px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: "4px",
                    background: "var(--surface)",
                  }}
                >
                  History
                </a>
              )}
            </div>

            {selectedAdr.status === "superseded" && selectedAdr.supersededBy && (
              <div style={{
                margin: "15px 20px 0 20px",
                padding: "10px 15px",
                borderRadius: "6px",
                background: "rgba(194, 65, 12, 0.08)",
                border: "1px solid rgba(194, 65, 12, 0.2)",
                color: "#c2410c",
                fontSize: "13px",
                fontWeight: "500",
              }}>
                This record is superseded by ADR #{String(selectedAdr.supersededBy).padStart(4, "0")}.
              </div>
            )}

            <div style={{ padding: "20px", flex: 1, background: "var(--surface)" }}>
              <h1 style={{ fontSize: "20px", marginTop: 0, borderBottom: "1px solid var(--border)", paddingBottom: "8px" }}>{selectedAdr.title}</h1>
              <Markdown text={selectedAdr.body} />
            </div>
          </div>
        ) : (
          <div className="empty-state">Select an ADR from the sidebar to view it.</div>
        )}
      </div>
    </div>
  );
}
