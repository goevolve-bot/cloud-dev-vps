import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { Header, type TabKey } from "./components/Header";
import { useProjects } from "./hooks/useProjects";
import { useTheme } from "./hooks/useTheme";
import { AdrsPage } from "./pages/AdrsPage";
import { SpecsPage } from "./pages/SpecsPage";
import { TasksPage } from "./pages/TasksPage";

interface ProjectShellProps {
  readonly tab: TabKey;
}

function ProjectShell({ tab }: ProjectShellProps) {
  const { project = "" } = useParams<{ project: string }>();
  const { projects, error } = useProjects();
  const [theme, toggleTheme] = useTheme();
  const navigate = useNavigate();

  useEffect(() => {
    if (projects && projects.length > 0 && !projects.some((p) => p.name === project)) {
      navigate(`/${projects[0].name}/${tab}`, { replace: true });
    }
  }, [projects, project, tab, navigate]);

  if (error) {
    return <div className="empty-state">Could not reach the pm API: {error}</div>;
  }
  if (!projects) {
    return <div className="empty-state">Loading…</div>;
  }
  if (projects.length === 0) {
    return <div className="empty-state">No projects yet.</div>;
  }

  const current = projects.some((p) => p.name === project) ? project : projects[0].name;

  return (
    <div className="shell">
      <Header
        projects={projects}
        currentProject={current}
        activeTab={tab}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      {tab === "tasks" && <TasksPage project={current} />}
      {tab === "specs" && <SpecsPage project={current} />}
      {tab === "adrs" && <AdrsPage project={current} />}
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/_/tasks" replace />} />
      <Route path="/:project/tasks" element={<ProjectShell tab="tasks" />} />
      <Route path="/:project/specs" element={<ProjectShell tab="specs" />} />
      <Route path="/:project/adrs" element={<ProjectShell tab="adrs" />} />
    </Routes>
  );
}
