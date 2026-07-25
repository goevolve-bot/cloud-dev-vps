import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { addRunOutcome, getAdapter, pmDirFor, findTask, writeTaskDescription, moveTaskStatus } from "@pm/core";
import { reindexTask } from "./indexer/index.js";
import type { RunnerRegistry } from "./runners/registry.js";
import { composePrompt, parseInterviewQuestions } from "./prompts.js";
import { callProjectctl } from "./projectctl.js";

export const sseEmitter = new EventEmitter();

// Historical import site — the client itself lives in projectctl.ts now that
// app.ts drives `create` through it too.
export { callProjectctl } from "./projectctl.js";

export const activeRunnerRunIds = new Map<number, number>();

// ─── Idle-timeout watcher (T35) ──────────────────────────────────────────────
// Default 30 minutes; override with PM_IDLE_TIMEOUT_MS env var.
const IDLE_TIMEOUT_MS = Number(process.env.PM_IDLE_TIMEOUT_MS) || 30 * 60 * 1000;
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleIdleDeactivation(
  db: Database.Database,
  projectId: number,
  projectName: string,
): void {
  // Cancel any existing timer for this project
  const existing = idleTimers.get(projectId);
  if (existing) clearTimeout(existing);

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
  }, IDLE_TIMEOUT_MS);

  idleTimers.set(projectId, timer);
}

export function cancelIdleTimer(projectId: number): void {
  const existing = idleTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    idleTimers.delete(projectId);
  }
}


export class QueueManager {
  private processing = false;

  constructor(
    private readonly db: Database.Database,
    private readonly runners: RunnerRegistry,
  ) {}

  init(): void {
    // Mark in-flight running runs as interrupted on restart
    this.db.prepare("UPDATE runs SET status = 'interrupted' WHERE status = 'running'").run();
  }

  trigger(): void {
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (true) {
        // 1. Check global concurrency limit (default 2)
        const activeCount = (
          this.db.prepare("SELECT COUNT(*) as count FROM runs WHERE status = 'running'").get() as any
        ).count;
        if (activeCount >= 2) break;

        // 2. Get queued runs
        const queued = this.db
          .prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY id")
          .all() as any[];
        if (queued.length === 0) break;

        // 3. Find the first queued run that doesn't have an active run on the same task
        let runToStart = null;
        for (const run of queued) {
          const taskActive = (
            this.db
              .prepare(
                "SELECT COUNT(*) as count FROM runs WHERE task_num = ? AND project_id = ? AND status = 'running'",
              )
              .get(run.task_num, run.project_id) as any
          ).count > 0;
          if (!taskActive) {
            runToStart = run;
            break;
          }
        }

        if (!runToStart) break;

        if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) {
          break;
        }

        // Start the run in the background
        void this.executeRun(runToStart);
        // Wait a tiny bit before processing the next one to avoid race conditions
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeRun(run: any): Promise<void> {
    try {
      const project = this.db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(run.project_id) as any;
      if (!project) throw new Error("Project not found");

      // Auto-activate project if stopped; cancel any pending idle timer
      cancelIdleTimer(project.id);
      if (this.runners.state(project.name) !== "connected") {
        await callProjectctl("start", { name: project.name });
        this.db
          .prepare("UPDATE projects SET lifecycle = 'active', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), project.id);
        let elapsed = 0;
        while (this.runners.state(project.name) !== "connected" && elapsed < 10000) {
          await new Promise((r) => setTimeout(r, 100));
          elapsed += 100;
        }
        if (this.runners.state(project.name) !== "connected") {
          throw new Error("Failed to activate project runner");
        }
      }

      const client = this.runners.client(project.name);
      if (!client) throw new Error("Runner client not connected");

      // Update DB to running
      this.db
        .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
        .run(new Date().toISOString(), run.id);

      const pmDir = pmDirFor(project.repo_dir);
      const task = await findTask(pmDir, run.task_num);
      if (!task) throw new Error("Task not found");

      let prompt = "";
      try {
        prompt = await composePrompt({
          phase: run.phase,
          task,
          pmDir,
          repoDir: project.repo_dir,
          db: this.db,
          projectId: project.id,
        });
        if (run.prompt) {
          prompt += `\n\nUser instructions:\n${run.prompt}`;
        }
      } catch (err) {
        console.error("Failed to compose prompt, falling back:", err);
        prompt = run.prompt || "";
      }

      // Call startRun
      const startResult = (await client.call("startRun", {
        taskId: run.task_num,
        phase: run.phase,
        provider: run.provider,
        model: run.model,
        prompt,
      })) as any;

      activeRunnerRunIds.set(run.id, startResult.runId);

      const logDir = join(process.env.PM_DATA_DIR || ".", "logs");
      await mkdir(logDir, { recursive: true });
      const logFilePath = join(logDir, `run-${run.id}.jsonl`);

      const logEvents: any[] = [];

      // Stream logs and write to file
      await client.call("streamLogs", { runId: startResult.runId }, async (event) => {
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

      const isSuccess = logEvents.find((e) => e.type === "result")?.subtype === "success";
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

      if (task) {
        await addRunOutcome(task, frontMatter, finalOutcome, { num: startResult.runId });

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
            await writeTaskDescription(task, cleanDescription);
          } else if (run.phase === "plan") {
            await writeFile(join(task.dir, "plan.md"), finalOutcome, "utf8");
          } else if (run.phase === "review") {
            await moveTaskStatus(pmDir, task, "ready-for-review");
          }
        }

        await reindexTask(this.db, { id: project.id, repoDir: project.repo_dir }, task.id);
        // Stage, commit, and push metadata on the default branch
        await client.call("commitAndPush", { branch: "" });
      }

      // Copy verify artifacts if the phase is "verify" and there is a verify-artifacts directory
      if (run.phase === "verify") {
        const repoPmDir = pmDirFor(project.repo_dir);
        const runArtifactsSrcDir = join(repoPmDir, "verify-artifacts", String(startResult.runId));
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
          isSuccess ? 0 : 1,
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
      activeRunnerRunIds.delete(run.id);
      // Notify SSE listeners that run is complete
      sseEmitter.emit(`run-${run.id}-end`);
      this.trigger();
      // Schedule idle deactivation if no runs remain and project is not always-on
      try {
        const proj = this.db
          .prepare("SELECT id, name, always_on FROM projects WHERE id = ?")
          .get(run.project_id) as { id: number; name: string; always_on: number } | undefined;
        if (proj && !proj.always_on) {
          scheduleIdleDeactivation(this.db, proj.id, proj.name);
        }
      } catch {
        // ignore — don't crash the queue over a timer
      }
    }
  }
}
