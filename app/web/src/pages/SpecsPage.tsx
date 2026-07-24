import { useEffect, useState } from "react";
import { fetchSpecs, fetchProjects, type Spec } from "../api";
import { Markdown } from "../components/Markdown";

export interface SpecsPageProps {
  readonly project: string;
}

export function SpecsPage({ project }: SpecsPageProps) {
  const [specs, setSpecs] = useState<Spec[] | null>(null);
  const [selectedSpec, setSelectedSpec] = useState<Spec | null>(null);
  const [gitUrl, setGitUrl] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        const [specsList, projectsList] = await Promise.all([
          fetchSpecs(project),
          fetchProjects(),
        ]);
        setSpecs(specsList);
        if (specsList.length > 0) {
          setSelectedSpec(specsList[0]);
        } else {
          setSelectedSpec(null);
        }
        const proj = projectsList.find((p) => p.name === project);
        setGitUrl(proj?.gitUrl);
      } catch (err: any) {
        setError(err.message || "Failed to load specs.");
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [project]);

  function getGitHistoryUrl(filePath: string): string | null {
    if (!gitUrl) return null;
    let webUrl = gitUrl;
    if (webUrl.startsWith("git@github.com:")) {
      webUrl = webUrl.replace("git@github.com:", "https://github.com/");
    } else if (webUrl.startsWith("git@github.com/")) {
      webUrl = webUrl.replace("git@github.com/", "https://github.com/");
    }
    if (webUrl.endsWith(".git")) {
      webUrl = webUrl.slice(0, -4);
    }
    return `${webUrl}/commits/main/${filePath}`;
  }

  if (loading) {
    return <div className="empty-state">Loading specs…</div>;
  }

  if (error) {
    return <div className="empty-state">Error: {error}</div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", flex: 1, overflow: "hidden" }}>
      <div style={{ borderRight: "1px solid var(--border)", background: "var(--surface)", overflowY: "auto", padding: "10px" }}>
        <h4 style={{ margin: "0 0 10px 0", color: "var(--muted)", textTransform: "uppercase", fontSize: "11px", letterSpacing: "0.5px" }}>Specs</h4>
        {specs && specs.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {specs.map((spec) => {
              const active = selectedSpec?.name === spec.name;
              return (
                <li key={spec.name} style={{ marginBottom: "4px" }}>
                  <button
                    onClick={() => setSelectedSpec(spec)}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: "4px",
                      background: active ? "var(--accent-soft)" : "transparent",
                      color: active ? "var(--accent)" : "var(--ink)",
                      fontWeight: active ? "600" : "normal",
                      fontSize: "13px",
                    }}
                  >
                    {spec.name}.md
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div style={{ color: "var(--muted)", fontStyle: "italic", fontSize: "12px" }}>No specs found.</div>
        )}
      </div>
      
      <div style={{ overflowY: "auto", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
        {selectedSpec ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 20px",
              background: "var(--surface)",
              borderBottom: "1px solid var(--border)",
            }}>
              <h2 style={{ margin: 0, fontSize: "16px", fontWeight: "600" }}>{selectedSpec.name}.md</h2>
              {getGitHistoryUrl(`.pm/specs/${selectedSpec.name}.md`) && (
                <a
                  href={getGitHistoryUrl(`.pm/specs/${selectedSpec.name}.md`)!}
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
            <div style={{ padding: "20px", flex: 1, background: "var(--surface)" }}>
              <Markdown text={selectedSpec.body} />
            </div>
          </div>
        ) : (
          <div className="empty-state">Select a spec file from the sidebar to view it.</div>
        )}
      </div>
    </div>
  );
}
