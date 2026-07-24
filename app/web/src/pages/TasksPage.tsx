export interface TasksPageProps {
  readonly project: string;
}

// The sidebar + task view land in T14; this shell just proves the route works.
export function TasksPage({ project }: TasksPageProps) {
  return <div className="page-placeholder">Tasks for “{project}” — coming in T14.</div>;
}
