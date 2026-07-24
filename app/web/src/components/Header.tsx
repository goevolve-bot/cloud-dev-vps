import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchMtdCost, type Project } from "../api";
import type { Theme } from "../hooks/useTheme";
import { SettingsModal } from "./SettingsModal";

export const TABS = [
  { key: "tasks", label: "Tasks" },
  { key: "specs", label: "Specs" },
  { key: "adrs", label: "ADRs" },
] as const;

export type TabKey = (typeof TABS)[number]["key"];

export interface HeaderProps {
  readonly projects: readonly Project[];
  readonly currentProject: string;
  readonly activeTab: TabKey;
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
  readonly onProjectsRefresh?: () => void;
}

const LIFECYCLE_COLORS: Record<string, string> = {
  active: "var(--green, #22c55e)",
  idle: "var(--yellow, #eab308)",
  stopped: "var(--muted)",
};

export function Header({
  projects,
  currentProject,
  activeTab,
  theme,
  onToggleTheme,
  onProjectsRefresh,
}: HeaderProps) {
  const navigate = useNavigate();
  const current = projects.find((p) => p.name === currentProject);
  const [showSettings, setShowSettings] = useState(false);
  const [mtdCost, setMtdCost] = useState<number | null>(null);

  // Fetch MTD cost (T37)
  useEffect(() => {
    async function load() {
      try {
        const data = await fetchMtdCost();
        setMtdCost(data.totalUsd);
      } catch {
        // ignore
      }
    }
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <header className="hbar">
        <span className="logo">pm</span>
        <select
          className="project-select"
          value={currentProject}
          onChange={(event) => navigate(`/${event.target.value}/${activeTab}`)}
          aria-label="project"
        >
          {projects.map((project) => (
            <option key={project.name} value={project.name}>
              {project.name}
            </option>
          ))}
        </select>
        <nav className="tabs">
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              to={`/${currentProject}/${tab.key}`}
              className={`tab${activeTab === tab.key ? " on" : ""}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <input className="search" placeholder="search tasks, specs, adrs…" aria-label="search" />
        <span className="spacer" />

        {/* MTD cost chip (T37) */}
        {mtdCost !== null && (
          <span className="chip" title={`Month-to-date spend`} style={{ fontVariantNumeric: "tabular-nums" }}>
            MTD ${mtdCost.toFixed(4)}
          </span>
        )}

        {current && (
          <>
            <span
              className={`chip compliance-badge ${current.contract?.isCompliant ? "compliant" : "non-compliant"}`}
              title={
                current.contract?.isCompliant
                  ? "Repository matches PM compliance contract"
                  : "Repository does not match PM compliance contract"
              }
            >
              {current.contract?.isCompliant ? "✓ compliant" : "✗ non-compliant"}
            </span>
            {/* Lifecycle badge (T35) */}
            <span
              className="chip"
              title={`runner: ${current.runnerState} · lifecycle: ${current.lifecycle}`}
              style={{ color: LIFECYCLE_COLORS[current.lifecycle] ?? "inherit" }}
            >
              <span className={`dot${current.runnerState === "connected" ? " live" : ""}`} />
              {current.lifecycle}
            </span>
          </>
        )}
        <button type="button" className="btn" onClick={onToggleTheme} aria-label="toggle theme">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button
          type="button"
          className="btn"
          aria-label="settings"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </button>
        <button type="button" className="btn" aria-label="logout">
          ⏻
        </button>
      </header>

      {showSettings && (
        <SettingsModal
          currentProject={current}
          onClose={() => setShowSettings(false)}
          onProjectUpdated={() => {
            onProjectsRefresh?.();
            setShowSettings(false);
          }}
        />
      )}
    </>
  );
}
