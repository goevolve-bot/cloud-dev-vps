import type { RunnerEvent, RunnerVerb, RunnerVerbs } from "@pm/core";

export interface HandlerContext {
  readonly project: string;
  readonly startedAt: number;
  readonly emit: (event: RunnerEvent) => void;
}

export type Handler<V extends RunnerVerb> = (
  args: RunnerVerbs[V]["args"],
  ctx: HandlerContext,
) => Promise<RunnerVerbs[V]["result"]>;

export class NotImplementedError extends Error {
  readonly code = "not_implemented";
}

/**
 * Real `status`, and a `streamLogs` that emits a canned "dummy log" so the
 * event path can be exercised end to end. The run-launching verbs are
 * deliberately stubbed — they need the workspace/queue/container machinery
 * built in T17-T19 and T22.
 */
export const handlers: { [V in RunnerVerb]: Handler<V> } = {
  status: async (_args, ctx) => ({
    project: ctx.project,
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
    activeRunIds: [],
  }),

  streamLogs: async (args, ctx) => {
    const lines = [
      `run ${args.runId}: no run queue yet (see T17-T19)`,
      `run ${args.runId}: this is a dummy log line`,
      `run ${args.runId}: end of dummy log`,
    ];
    for (const line of lines) {
      ctx.emit({ type: "log", runId: args.runId, line });
    }
    return { runId: args.runId, complete: true };
  },

  startRun: async () => {
    throw new NotImplementedError("startRun is not implemented yet (see T17/T18)");
  },

  stopRun: async () => {
    throw new NotImplementedError("stopRun is not implemented yet (see T18)");
  },

  commitAndPush: async () => {
    throw new NotImplementedError("commitAndPush is not implemented yet (see T22)");
  },
};
