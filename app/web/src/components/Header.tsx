import { Link, useNavigate } from "react-router-dom";
import type { Project } from "../api";
import type { Theme } from "../hooks/useTheme";

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
}

export function Header({ projects, currentProject, activeTab, theme, onToggleTheme }: HeaderProps) {
  const navigate = useNavigate();
  const current = projects.find((p) => p.name === currentProject);

  return (
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
          <span className="chip" title={`runner: ${current.runnerState}`}>
            <span className={`dot${current.runnerState === "connected" ? " live" : ""}`} />
            {current.lifecycle}
          </span>
        </>
      )}
      <button type="button" className="btn" onClick={onToggleTheme} aria-label="toggle theme">
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <button type="button" className="btn" aria-label="settings">
        ⚙
      </button>
      <button type="button" className="btn" aria-label="logout">
        ⏻
      </button>
    </header>
  );
}
