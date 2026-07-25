import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fetchMtdCost,
  searchProject,
  setProjectLifecycle,
  type Project,
  type SearchResult,
} from "../api";
import type { Theme } from "../hooks/useTheme";
import { AddProjectModal } from "./AddProjectModal";
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

// Sentinel option value — not a legal project name (uppercase, and no project
// name may contain a space), so it can never collide with a real one.
const ADD_PROJECT = "+ add project…";

const LIFECYCLE_COLORS: Record<string, string> = {
  active: "var(--green, #22c55e)",
  idle: "var(--yellow, #eab308)",
  stopped: "var(--muted)",
};

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN_LENGTH = 2;

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
  const [showAddProject, setShowAddProject] = useState(false);
  const [mtdCost, setMtdCost] = useState<number | null>(null);
  const [togglingLifecycle, setTogglingLifecycle] = useState(false);
  const [togglingAlwaysOn, setTogglingAlwaysOn] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBlurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  // Debounced project search over cached tasks/specs/ADRs.
  useEffect(() => {
    const query = searchQuery.trim();
    if (!currentProject || query.length < SEARCH_MIN_LENGTH) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    const id = setTimeout(() => {
      void searchProject(currentProject, query)
        .then((results) => {
          setSearchResults(results);
          setSearchOpen(true);
        })
        .catch(() => setSearchResults([]));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchQuery, currentProject]);

  function handleResultClick(result: SearchResult): void {
    setSearchOpen(false);
    setSearchQuery("");
    const tab: TabKey = result.type === "task" ? "tasks" : result.type === "spec" ? "specs" : "adrs";
    navigate(`/${currentProject}/${tab}`);
  }

  async function handleLogout(): Promise<void> {
    // HTTP Basic auth has no logout endpoint or API to clear cached
    // credentials. The standard workaround: send a request with deliberately
    // wrong credentials so the browser evicts the ones it cached, then
    // reload so the next request re-prompts for a login.
    try {
      await fetch(window.location.origin, {
        headers: { Authorization: `Basic ${btoa("logout:logout")}` },
        cache: "no-store",
      });
    } catch {
      // ignore — reloading regardless surfaces the re-prompt either way
    } finally {
      window.location.reload();
    }
  }

  async function handleToggleLifecycle(): Promise<void> {
    if (!current || togglingLifecycle) return;
    setTogglingLifecycle(true);
    try {
      await setProjectLifecycle(current.name, current.lifecycle === "stopped" ? "start" : "stop");
      onProjectsRefresh?.();
    } catch (err) {
      console.error("Failed to toggle project lifecycle", err);
    } finally {
      setTogglingLifecycle(false);
    }
  }

  async function handleToggleAlwaysOn(): Promise<void> {
    if (!current || togglingAlwaysOn) return;
    setTogglingAlwaysOn(true);
    try {
      await setProjectLifecycle(current.name, "set-always-on", !current.alwaysOn);
      onProjectsRefresh?.();
    } catch (err) {
      console.error("Failed to toggle always-on", err);
    } finally {
      setTogglingAlwaysOn(false);
    }
  }

  return (
    <>
      <header className="hbar">
        <span className="logo">pm</span>
        <select
          className="project-select"
          value={currentProject}
          onChange={(event) => {
            if (event.target.value === ADD_PROJECT) {
              // `value` is controlled by currentProject, so the select snaps
              // back to the current project on the next render by itself.
              setShowAddProject(true);
              return;
            }
            navigate(`/${event.target.value}/${activeTab}`);
          }}
          aria-label="project"
        >
          {projects.length === 0 && <option value="">no projects</option>}
          {projects.map((project) => (
            <option key={project.name} value={project.name}>
              {project.name}
            </option>
          ))}
          <option value={ADD_PROJECT}>{ADD_PROJECT}</option>
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
        <div className="search-wrap" style={{ position: "relative" }}>
          <input
            className="search"
            placeholder="search tasks, specs, adrs…"
            aria-label="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onFocus={() => {
              if (searchResults.length > 0) setSearchOpen(true);
            }}
            onBlur={() => {
              // Delay so a click on a result registers before the list unmounts.
              searchBlurTimer.current = setTimeout(() => setSearchOpen(false), 150);
            }}
          />
          {searchOpen && (
            <div
              className="search-results"
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                marginTop: 4,
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                maxHeight: 320,
                overflowY: "auto",
                zIndex: 1001,
              }}
            >
              {searchResults.length === 0 ? (
                <div className="muted" style={{ padding: "10px 12px", fontSize: 12 }}>
                  No matches.
                </div>
              ) : (
                searchResults.map((result, idx) => (
                  <button
                    key={`${result.type}-${idx}`}
                    type="button"
                    onMouseDown={(event) => {
                      // Beat the input's onBlur close-timer.
                      event.preventDefault();
                      if (searchBlurTimer.current) clearTimeout(searchBlurTimer.current);
                      handleResultClick(result);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 12px",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--ink)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600 }}>
                      <span className="muted">{result.type}</span> {result.title}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {result.snippet}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
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
            {/* Lifecycle badge (T35) — clickable: starts a stopped project,
                stops an active/idle one. Start/stop used to live only in the
                settings modal. */}
            <button
              type="button"
              className="chip"
              onClick={() => void handleToggleLifecycle()}
              disabled={togglingLifecycle}
              title={`runner: ${current.runnerState} · lifecycle: ${current.lifecycle} · click to ${
                current.lifecycle === "stopped" ? "start" : "stop"
              }`}
              style={{
                color: LIFECYCLE_COLORS[current.lifecycle] ?? "inherit",
                cursor: togglingLifecycle ? "wait" : "pointer",
              }}
            >
              <span className={`dot${current.runnerState === "connected" ? " live" : ""}`} />
              {togglingLifecycle ? "…" : current.lifecycle}
            </button>
            <button
              type="button"
              className={`btn${current.alwaysOn ? " on" : ""}`}
              onClick={() => void handleToggleAlwaysOn()}
              disabled={togglingAlwaysOn}
              aria-label="toggle always on"
              title={
                current.alwaysOn
                  ? "Always on — never idle-stopped. Click to allow idle-stop."
                  : "Pin always on — never idle-stopped"
              }
            >
              📌
            </button>
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
        <button
          type="button"
          className="btn"
          aria-label="logout"
          title="Log out (clears cached credentials and reloads)"
          onClick={() => void handleLogout()}
        >
          ⏻
        </button>
      </header>

      {showAddProject && (
        <AddProjectModal
          onClose={() => setShowAddProject(false)}
          onCreated={(project) => {
            setShowAddProject(false);
            onProjectsRefresh?.();
            navigate(`/${project.name}/${activeTab}`);
          }}
        />
      )}

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
