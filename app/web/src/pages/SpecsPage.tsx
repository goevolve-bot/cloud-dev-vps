export interface SpecsPageProps {
  readonly project: string;
}

// Rendered spec list + markdown view lands in T34.
export function SpecsPage({ project }: SpecsPageProps) {
  return <div className="page-placeholder">Specs for “{project}” — coming in T34.</div>;
}
