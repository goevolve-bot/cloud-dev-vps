// The runner's control protocol: pm talks to each project's runner over a
// unix socket (see docs/pm-system-plan.md), one NDJSON request per line,
// answered by zero or more `event` messages and exactly one terminal
// `result`/`error` message carrying the same request id. A single connection
// may have several requests in flight at once, multiplexed by id.

export interface StartRunArgs {
  /**
   * pm's own `runs.id`. pm owns run identity: the runner uses this for its log
   * path and container name, so ids are unique across every task and survive a
   * pm restart (the row itself is the mapping).
   */
  readonly runId: number;
  readonly taskId: number;
  readonly phase: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  /** Wall-clock budget for the run. Defaults to the runner's own configuration. */
  readonly timeoutMs?: number;
}

export interface StartRunResult {
  readonly runId: number;
  readonly status: "queued" | "running";
}

export interface StopRunArgs {
  readonly runId: number;
}

export interface StopRunResult {
  readonly runId: number;
  readonly stopped: boolean;
}

export interface StreamLogsArgs {
  readonly runId: number;
}

export interface StreamLogsResult {
  readonly runId: number;
  /** True once the run's log is known to be finished (nothing more will follow). */
  readonly complete: boolean;
  /**
   * The run's real process exit code, or null when the runner no longer
   * remembers it (a restart, or an id it never saw). pm records this verbatim
   * instead of inferring success from the agent's JSON output.
   */
  readonly exitCode?: number | null;
}

export type StatusArgs = Record<string, never>;

export interface StatusResult {
  readonly project: string;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly activeRunIds: readonly number[];
}

export interface CommitAndPushArgs {
  /** A `pm/task-<id>-<slug>` branch, or "" for the default branch's `.pm/` metadata. */
  readonly branch: string;
  /** Commit message for anything the agent left uncommitted. */
  readonly message?: string;
}

export interface CommitAndPushResult {
  readonly branch: string;
  readonly pushed: boolean;
  /** True when residual changes were staged and committed by this call. */
  readonly committed: boolean;
  /** Why the push did not happen, when `pushed` is false. */
  readonly error?: string;
}

/**
 * `git diff <base>...<branch>`, computed by the runner because only the runner
 * has the project's repo — pm never runs git for a project.
 */
export interface DiffArgs {
  readonly branch: string;
  /** Defaults to the repo's default branch. */
  readonly base?: string;
}

export interface DiffResult {
  readonly branch: string;
  readonly base: string;
  readonly diff: string;
  /** False when the branch does not exist yet; `diff` is then empty. */
  readonly found: boolean;
}

export type SweepVerifyEnvsArgs = Record<string, never>;

export interface SweepVerifyEnvsResult {
  /** Compose project names that were torn down. */
  readonly removed: readonly string[];
}

export interface RunnerVerbs {
  startRun: { args: StartRunArgs; result: StartRunResult };
  stopRun: { args: StopRunArgs; result: StopRunResult };
  streamLogs: { args: StreamLogsArgs; result: StreamLogsResult };
  status: { args: StatusArgs; result: StatusResult };
  commitAndPush: { args: CommitAndPushArgs; result: CommitAndPushResult };
  diff: { args: DiffArgs; result: DiffResult };
  sweepVerifyEnvs: { args: SweepVerifyEnvsArgs; result: SweepVerifyEnvsResult };
}

export type RunnerVerb = keyof RunnerVerbs;

export interface RunnerRequest<V extends RunnerVerb = RunnerVerb> {
  readonly id: string;
  readonly verb: V;
  readonly args: RunnerVerbs[V]["args"];
}

export interface RunnerLogEvent {
  readonly type: "log";
  readonly runId: number;
  readonly line: string;
}

export type RunnerEvent = RunnerLogEvent;

export type RunnerMessage<V extends RunnerVerb = RunnerVerb> =
  | { readonly type: "event"; readonly id: string; readonly event: RunnerEvent }
  | {
      readonly type: "result";
      readonly id: string;
      readonly ok: true;
      readonly data: RunnerVerbs[V]["result"];
    }
  | {
      readonly type: "error";
      readonly id: string;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };
