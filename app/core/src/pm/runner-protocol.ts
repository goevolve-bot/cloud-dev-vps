// The runner's control protocol: pm talks to each project's runner over a
// unix socket (see docs/pm-system-plan.md), one NDJSON request per line,
// answered by zero or more `event` messages and exactly one terminal
// `result`/`error` message carrying the same request id. A single connection
// may have several requests in flight at once, multiplexed by id.

export interface StartRunArgs {
  readonly taskId: number;
  readonly phase: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
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
}

export type StatusArgs = Record<string, never>;

export interface StatusResult {
  readonly project: string;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly activeRunIds: readonly number[];
}

export interface CommitAndPushArgs {
  readonly branch: string;
}

export interface CommitAndPushResult {
  readonly branch: string;
  readonly pushed: boolean;
}

export interface RunnerVerbs {
  startRun: { args: StartRunArgs; result: StartRunResult };
  stopRun: { args: StopRunArgs; result: StopRunResult };
  streamLogs: { args: StreamLogsArgs; result: StreamLogsResult };
  status: { args: StatusArgs; result: StatusResult };
  commitAndPush: { args: CommitAndPushArgs; result: CommitAndPushResult };
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
