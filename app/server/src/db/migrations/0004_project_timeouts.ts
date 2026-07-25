// Migration 0004: per-project timeouts.
//
// The plan makes the idle timeout ("stop a project after 15 minutes of
// inactivity") a per-project setting, not one global number, and the same
// argument applies to the per-run wall-clock budget: a project whose test
// suite takes 40 minutes should not have to raise the limit for everyone.
// NULL means "use the global default".
export const version = 4;
export const name = "project_timeouts";

export const up = `
ALTER TABLE projects ADD COLUMN idle_timeout_ms INTEGER;
ALTER TABLE projects ADD COLUMN run_timeout_ms INTEGER;
`;

export const down = `
ALTER TABLE projects DROP COLUMN idle_timeout_ms;
ALTER TABLE projects DROP COLUMN run_timeout_ms;
`;
