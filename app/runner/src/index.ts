// Per-project runner: owns the rootless docker socket and secrets, exposes the
// narrow control API (startRun/stopRun/streamLogs/status/commitAndPush) — see
// T10 in docs/pm-task-breakdown.md.
export const RUNNER_PACKAGE_NAME = "@pm/runner";
