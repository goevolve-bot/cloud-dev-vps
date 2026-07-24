export interface AdrsPageProps {
  readonly project: string;
}

// Rendered ADR list + status chips lands in T34.
export function AdrsPage({ project }: AdrsPageProps) {
  return <div className="page-placeholder">ADRs for “{project}” — coming in T34.</div>;
}
