import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import type Database from "better-sqlite3";
import { addRunOutcome, getAdapter, pmDirFor, findTask } from "@pm/core";
import { reindexTask } from "./indexer/index.js";
import type { RunnerRegistry } from "./runners/registry.js";

export const sseEmitter = new EventEmitter();

interface ProjectctlResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly data?: any;
}

export function callProjectctl(
  verb: string,
  args: Record<string, any>,
): Promise<ProjectctlResult> {
  return new Promise((resolve) => {
    const socket = createConnection("/srv/pm/projectctl.sock");
    socket.setEncoding("utf8");

    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ verb, args })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "result" || msg.type === "error") {
            socket.end();
            resolve(msg);
            return;
          }
        } catch (err) {
          socket.end();
          resolve({ ok: false, code: "parse_error", message: String(err) });
          return;
        }
      }
    });

    socket.on("error", (err) => {
      resolve({ ok: false, code: "connection_error", message: err.message });
    });
  });
}

export const activeRunnerRunIds = new Map<number, number>();

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

      // Auto-activate project if stopped
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

      const client = this.runners.client(project.name);
      if (!client) throw new Error("Runner client not connected");

      // Update DB to running
      this.db
        .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
        .run(new Date().toISOString(), run.id);

      let prompt = run.prompt || "";
      if (run.phase === "implement") {
        const lastFailedVerify = this.db
          .prepare(
            "SELECT outcome FROM task_runs WHERE project_id = ? AND task_num = ? AND phase = 'verify' AND status = 'failed' ORDER BY run_num DESC LIMIT 1"
          )
          .get(run.project_id, run.task_num) as { outcome: string } | undefined;
        if (lastFailedVerify && lastFailedVerify.outcome) {
          prompt += `\n\nPrevious verification failed with the following output:\n${lastFailedVerify.outcome}`;
        }

        let isCompliant = false;
        if (project.contract_json) {
          try {
            const parsed = JSON.parse(project.contract_json);
            if (parsed && parsed.isCompliant) {
              isCompliant = true;
            }
          } catch {
            // ignore
          }
        }
        if (!isCompliant) {
          prompt += "\n\npart of your job is to make this repo compliant — add the Dockerfile, compose environment with healthcheck, and (for UI projects) e2e tests.";
        }
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

      const pmDir = pmDirFor(project.repo_dir);
      const task = await findTask(pmDir, run.task_num);
      if (task) {
        await addRunOutcome(task, frontMatter, finalOutcome, { num: startResult.runId });
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
    }
  }
}
