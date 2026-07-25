import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  addRunOutcome,
  getAdapter,
  pmDirFor,
  findTask,
  writeTaskDescription,
  moveTaskStatus,
  type RunEvent,
  type TaskStatus,
} from "@pm/core";
import { reindexTask } from "./indexer/index.js";
import type { RunnerRegistry } from "./runners/registry.js";
import { composePrompt, parseInterviewQuestions } from "./prompts.js";
import { callProjectctl } from "./projectctl.js";

export const sseEmitter = new EventEmitter();

// Historical import site — the client itself lives in projectctl.ts now that
// app.ts drives `create` through it too.
export { callProjectctl } from "./projectctl.js";

// ─── Configuration ───────────────────────────────────────────────────────────
// Global defaults; the per-project columns on `projects` win where they are set.

/** The plan's number: 15 minutes of inactivity before a project is stopped. */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_RUNS = 2;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function idleTimeoutMs(project: { idle_timeout_ms?: number | null }): number {
  if (project.idle_timeout_ms && project.idle_timeout_ms > 0) return project.idle_timeout_ms;
  return envNumber("PM_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
}

function runTimeoutMs(project: { run_timeout_ms?: number | null }): number {
  if (project.run_timeout_ms && project.run_timeout_ms > 0) return project.run_timeout_ms;
  return envNumber("PM_RUN_TIMEOUT_MS", DEFAULT_RUN_TIMEOUT_MS);
}

function maxConcurrentRuns(): number {
  return envNumber("PM_MAX_CONCURRENT_RUNS", DEFAULT_MAX_CONCURRENT_RUNS);
}

// ─── Idle-timeout watcher (T35) ──────────────────────────────────────────────
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleIdleDeactivation(
  db: Database.Database,
  runners: RunnerRegistry,
  projectId: number,
  projectName: string,
  timeoutMs: number,
): void {
  // Cancel any existing timer for this project
  const existing = idleTimers.get(projectId);
  if (existing) clearTimeout(existing);

  // The project is connected but has no active work and isn't pinned — that's
  // 'idle', distinct from both 'active' (a run is in flight) and 'stopped'
  // (the runner is down). Previously nothing ever wrote this state, so the
  // header's idle badge color was dead code.
  db.prepare("UPDATE projects SET lifecycle = 'idle', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    projectId,
  );

  const timer = setTimeout(async () => {
    idleTimers.delete(projectId);

    // Re-check: don't deactivate if always_on or if new runs appeared
    const project = db.prepare("SELECT always_on FROM projects WHERE id = ?").get(projectId) as
      | { always_on: number }
      | undefined;
    if (!project || project.always_on) return;

    const active = (
      db
        .prepare(
          "SELECT COUNT(*) as count FROM runs WHERE project_id = ? AND status IN ('running','queued')",
        )
        .get(projectId) as { count: number }
    ).count;
    if (active > 0) return;

    console.log(`[idle-timeout] Deactivating idle project ${projectName}`);
    // The plan's stop sequence: compose down any leftover verification
    // environments first, while the runner is still up to do it.
    try {
      const client = runners.client(projectName);
      if (client && runners.state(projectName) === "connected") {
        const swept = await client.call("sweepVerifyEnvs", {});
        if (swept.removed.length > 0) {
          console.log(
            `[idle-timeout] Removed leftover verification environments: ${swept.removed.join(", ")}`,
          );
        }
      }
    } catch (err) {
      console.error(`[idle-timeout] Verification environment sweep failed for ${projectName}:`, err);
    }

    try {
      const result = await callProjectctl("stop", { name: projectName });
      if (result.ok) {
        db.prepare("UPDATE projects SET lifecycle = 'stopped', updated_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          projectId,
        );
      }
    } catch (err) {
      console.error(`[idle-timeout] Failed to stop ${projectName}:`, err);
    }
  }, timeoutMs);

  // A pending idle timer must never be the reason the process stays alive.
  timer.unref?.();
  idleTimers.set(projectId, timer);
}

export function cancelIdleTimer(projectId: number): void {
  const existing = idleTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    idleTimers.delete(projectId);
  }
}

/**
 * Where a phase leaves the task when it succeeds. The board should reflect
 * what the system actually did without anyone touching the status dropdown.
 */
const PHASE_TARGET_STATUS: Record<string, TaskStatus> = {
  verify: "ready-for-review",
  review: "ready-for-review",
};

/** Phases that mean somebody is working on the task now. */
const PHASES_STARTING_WORK = new Set(["implement", "verify", "review"]);

/** A row from the runtime `runs` table (see db/migrations/0001_init.ts). */
interface RunRow {
  id: number;
  project_id: number;
  task_num: number;
  phase: string;
  provider: string;
  model: string;
  prompt: string | null;
  status: string;
  exit_code: number | null;
  log_path: string | null;
  artifacts_dir: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ProjectRow {
  id: number;
  name: string;
  repo_dir: string;
  runner_socket: string | null;
  default_provider: string | null;
  default_model: string | null;
  contract_json: string | null;
  lifecycle: string;
  always_on: number;
  idle_timeout_ms: number | null;
  run_timeout_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface QueueManagerOptions {
  /**
   * Whether the queue may actually start runs. Off by default under
   * `node --test`, so a test that posts a run does not spawn a container.
   */
  readonly autoStart?: boolean;
  /** Test seam: replaces the real executor. */
  readonly execute?: (run: RunRow) => Promise<void>;
}

export class QueueManager {
  private processing = false;
  private stopped = false;
  private readonly autoStart: boolean;
  private readonly execute: (run: RunRow) => Promise<void>;

  constructor(
    private readonly db: Database.Database,
    private readonly runners: RunnerRegistry,
    opts: QueueManagerOptions = {},
  ) {
    this.autoStart =
      opts.autoStart ?? !(process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT);
    this.execute = opts.execute ?? ((run) => this.executeRun(run));
  }

  init(): void {
    // Mark in-flight running runs as interrupted on restart
    this.db.prepare("UPDATE runs SET status = 'interrupted' WHERE status = 'running'").run();
    // Runs that were still queued at shutdown are ours to finish; without this
    // they sit untouched until somebody happens to post a new run.
    this.trigger();
  }

  trigger(): void {
    void this.processQueue();
  }

  /** Stops claiming new runs. In-flight runs are left to finish. */
  stop(): void {
    this.stopped = true;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;

    try {
      const limit = maxConcurrentRuns();
      while (true) {
        // 1. Check global concurrency limit
        const activeCount = (
          this.db
            .prepare("SELECT COUNT(*) as count FROM runs WHERE status = 'running'")
            .get() as { count: number }
        ).count;
        if (activeCount >= limit) break;

        // 2. Get queued runs
        const queued = this.db
          .prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY id")
          .all() as RunRow[];
        if (queued.length === 0) break;

        // 3. Find the first queued run that doesn't have an active run on the same task
        let runToStart: RunRow | null = null;
        for (const run of queued) {
          const taskActive =
            (
              this.db
                .prepare(
                  "SELECT COUNT(*) as count FROM runs WHERE task_num = ? AND project_id = ? AND status = 'running'",
                )
                .get(run.task_num, run.project_id) as { count: number }
            ).count > 0;
          if (!taskActive) {
            runToStart = run;
            break;
          }
        }

        if (!runToStart) break;
        if (!this.autoStart) break;

        // Claim the row before doing anything asynchronous. The loop re-reads
        // `queued` on every pass, so a row that is still 'queued' when we come
        // back around would otherwise be started twice.
        if (!this.claim(runToStart)) continue;

        // Start the run in the background
        void this.execute(runToStart);
        // Yield so the started run gets a chance to register before we look again
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Flips one queued row to `running`. Conditional on the row still being
   * queued, so two passes of the loop (or two callers of trigger()) cannot
   * both claim it.
   */
  private claim(run: RunRow): boolean {
    const startedAt = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(startedAt, run.id);
    if (result.changes === 0) return false;
    run.status = "running";
    run.started_at = startedAt;
    return true;
  }

  private async executeRun(run: RunRow): Promise<void> {
    if (this.stopped) {
      // Shut down between the claim and the start: hand the row back.
      this.db
        .prepare("UPDATE runs SET status = 'queued', started_at = NULL WHERE id = ?")
        .run(run.id);
      return;
    }
    try {
      const project = this.db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(run.project_id) as ProjectRow | undefined;
      if (!project) throw new Error("Project not found");

      // Auto-activate project if stopped; cancel any pending idle timer
      cancelIdleTimer(project.id);
      if (this.runners.state(project.name) !== "connected") {
        await callProjectctl("start", { name: project.name });
        let elapsed = 0;
        while (this.runners.state(project.name) !== "connected" && elapsed < 10000) {
          await new Promise((r) => setTimeout(r, 100));
          elapsed += 100;
        }
        if (this.runners.state(project.name) !== "connected") {
          throw new Error("Failed to activate project runner");
        }
      }
      // A project can already be 'connected' but sitting in 'idle' (timer
      // pending, no runner restart needed) — mark it active unconditionally
      // whenever a run actually starts, not only on the cold-start path.
      this.db
        .prepare("UPDATE projects SET lifecycle = 'active', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), project.id);

      const client = this.runners.client(project.name);
      if (!client) throw new Error("Runner client not connected");

      const pmDir = pmDirFor(project.repo_dir);
      const task = await findTask(pmDir, run.task_num);
      if (!task) throw new Error("Task not found");

      // The board should show work as in progress the moment it starts.
      let currentTask = task;
      if (PHASES_STARTING_WORK.has(run.phase) && currentTask.status === "todo") {
        currentTask = await moveTaskStatus(pmDir, currentTask, "in-progress");
      }

      // Verify has no agent and so no prompt template: the runner runs the
      // project's own compose services.
      let prompt = run.prompt || "";
      if (run.phase !== "verify") {
        try {
          prompt = await composePrompt({
            phase: run.phase,
            task: currentTask,
            pmDir,
            repoDir: project.repo_dir,
            db: this.db,
            projectId: project.id,
            runnerClient: client,
          });
          if (run.prompt) {
            prompt += `\n\nUser instructions:\n${run.prompt}`;
          }
        } catch (err) {
          console.error("Failed to compose prompt, falling back:", err);
          prompt = run.prompt || "";
        }
      }

      // pm owns run identity: the runner uses run.id for its log path and
      // container name, so nothing collides across tasks and a restarted pm
      // can still address an in-flight run by its row id.
      await client.call("startRun", {
        runId: run.id,
        taskId: run.task_num,
        phase: run.phase,
        provider: run.provider,
        model: run.model,
        prompt,
        timeoutMs: runTimeoutMs(project),
      });

      const logDir = join(process.env.PM_DATA_DIR || ".", "logs");
      await mkdir(logDir, { recursive: true });
      const logFilePath = join(logDir, `run-${run.id}.jsonl`);

      const logEvents: RunEvent[] = [];

      // Stream logs and write to file
      const streamResult = await client.call("streamLogs", { runId: run.id }, async (event) => {
        if (event.type === "log") {
          await appendFile(logFilePath, `${event.line}\n`);
          sseEmitter.emit(`run-${run.id}`, event.line);

          try {
            const parsed = JSON.parse(event.line);
            logEvents.push(parsed);
          } catch {
            // ignore non-JSON log lines
          }
        }
      });

      // Stream logs completed
      const adapter = getAdapter(run.provider);
      const finalCost = adapter.extractCost(logEvents) || { usd: 0, tokensIn: 0, tokensOut: 0 };
      const finalOutcome = adapter.extractOutcome(logEvents) || "Run completed.";

      // The container's real exit code decides. A crashed agent that emitted
      // no JSON is a failure; an agent that exited 0 with an output shape we
      // don't recognise is not. The JSON result only downgrades an exit-0 run
      // when it explicitly says the agent failed.
      const exitCode = streamResult.exitCode ?? null;
      const resultEvent = logEvents.find((e) => e.type === "result");
      const jsonSaysSuccess = resultEvent ? resultEvent.subtype === "success" : null;
      const isSuccess =
        exitCode === null
          ? jsonSaysSuccess === true
          : exitCode === 0 && jsonSaysSuccess !== false;
      const status = isSuccess ? "succeeded" : "failed";

      const frontMatter = {
        phase: run.phase,
        provider: run.provider,
        model: run.model,
        status,
        costUsd: finalCost.usd,
        tokensIn: finalCost.tokensIn,
        tokensOut: finalCost.tokensOut,
        startedAt: run.started_at || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };

      // Force the repo-side runs/NNNN.md number to equal pm's own runtime
      // run id, rather than letting addRunOutcome pick the next free one in
      // sequence. This is what makes task_runs.run_num == runs.id — the
      // basis for correlating a repo-side run to its runtime run everywhere
      // else (the UI timeline, the artifacts routes) instead of matching on
      // (phase, started_at), which collides on same-millisecond starts or a
      // null started_at.
      await addRunOutcome(currentTask, frontMatter, finalOutcome, { num: run.id });

      if (status === "succeeded") {
        if (run.phase === "interview") {
          const questions = parseInterviewQuestions(finalOutcome);
          for (const q of questions) {
            this.db
              .prepare(
                "INSERT INTO questions (project_id, task_num, run_id, text) VALUES (?, ?, ?, ?)"
              )
              .run(run.project_id, run.task_num, run.id, q);
          }
        } else if (run.phase === "refine") {
          const cleanDescription = finalOutcome.trim();
          currentTask = await writeTaskDescription(currentTask, cleanDescription);
        } else if (run.phase === "plan") {
          await writeFile(join(currentTask.dir, "plan.md"), finalOutcome, "utf8");
        }

        const targetStatus = PHASE_TARGET_STATUS[run.phase];
        if (targetStatus && currentTask.status !== targetStatus) {
          currentTask = await moveTaskStatus(pmDir, currentTask, targetStatus);
        }
      }

      await reindexTask(this.db, { id: project.id, repoDir: project.repo_dir }, currentTask.id);
      // Stage, commit, and push metadata on the default branch
      await client.call("commitAndPush", { branch: "" });

      // An implement run's own work lives on the task branch: commit whatever
      // the agent left behind and push it, so the follow-on verify (which
      // clones origin) actually sees the change.
      if (run.phase === "implement") {
        const branch = `pm/task-${currentTask.id}-${currentTask.slug}`;
        const pushResult = await client.call("commitAndPush", {
          branch,
          message: `pm: implement task ${currentTask.id} — ${currentTask.title}`,
        });
        if (!pushResult.pushed) {
          console.error(`run ${run.id}: failed to push ${branch}: ${pushResult.error ?? "unknown error"}`);
        }
      }

      // Copy verify artifacts if the phase is "verify" and there is a verify-artifacts directory
      if (run.phase === "verify") {
        const repoPmDir = pmDirFor(project.repo_dir);
        const runArtifactsSrcDir = join(repoPmDir, "verify-artifacts", String(run.id));
        const artifactsDestDir = join(process.env.PM_DATA_DIR || ".", "artifacts", String(run.id));

        try {
          await mkdir(artifactsDestDir, { recursive: true });
          const files = await readdir(runArtifactsSrcDir);
          for (const file of files) {
            await copyFile(join(runArtifactsSrcDir, file), join(artifactsDestDir, file));
          }
          // Update DB row with artifacts directory
          this.db
            .prepare("UPDATE runs SET artifacts_dir = ? WHERE id = ?")
            .run(artifactsDestDir, run.id);
        } catch {
          // ignore if no artifacts or copy failed
        }
      }

      this.db
        .prepare(
          "UPDATE runs SET status = ?, exit_code = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, finished_at = ?, log_path = ? WHERE id = ?",
        )
        .run(
          status,
          exitCode,
          finalCost.usd,
          finalCost.tokensIn,
          finalCost.tokensOut,
          frontMatter.finishedAt,
          logFilePath,
          run.id,
        );

      // Auto-run verify after a successful implement run
      if (run.phase === "implement" && status === "succeeded") {
        this.db.prepare(
          "INSERT INTO runs (project_id, task_num, phase, provider, model, prompt, status, created_at) VALUES (?, ?, 'verify', ?, ?, '', 'queued', ?)"
        ).run(
          project.id,
          run.task_num,
          run.provider,
          run.model,
          new Date().toISOString()
        );
      }
    } catch (err) {
      console.error(`Error executing run ${run.id}:`, err);
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', exit_code = 1, finished_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), run.id);
    } finally {
      // Notify SSE listeners that run is complete
      sseEmitter.emit(`run-${run.id}-end`);
      this.trigger();
      // Schedule idle deactivation if no runs remain and project is not always-on
      try {
        const proj = this.db
          .prepare("SELECT id, name, always_on, idle_timeout_ms FROM projects WHERE id = ?")
          .get(run.project_id) as
          | { id: number; name: string; always_on: number; idle_timeout_ms: number | null }
          | undefined;
        if (proj && !proj.always_on) {
          scheduleIdleDeactivation(this.db, this.runners, proj.id, proj.name, idleTimeoutMs(proj));
        }
      } catch {
        // ignore — don't crash the queue over a timer
      }
    }
  }
}
