import { childProcess } from "./exec.js";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  findTask,
  getAdapter,
  pmDirFor,
  slugify,
  type RunnerEvent,
  type RunnerVerb,
  type RunnerVerbs,
} from "@pm/core";

const execFileAsync = (file: string, args: string[], opts?: any) => childProcess.execFileAsync(file, args, opts);

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

// Log management
class RunLogManager {
  private readonly emitters = new Map<number, EventEmitter>();

  getEmitter(runId: number): EventEmitter {
    let emitter = this.emitters.get(runId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.emitters.set(runId, emitter);
    }
    return emitter;
  }

  deleteEmitter(runId: number): void {
    this.emitters.delete(runId);
  }

  getLogPath(runId: number): string {
    return join(os.homedir(), "logs", `${runId}.log`);
  }

  async ensureLogDir(): Promise<void> {
    await mkdir(join(os.homedir(), "logs"), { recursive: true });
  }

  async appendLine(runId: number, line: string): Promise<void> {
    const logPath = this.getLogPath(runId);
    const emitter = this.getEmitter(runId);
    await appendFile(logPath, `${line}\n`);
    emitter.emit("line", line);
  }

  async getExistingLines(runId: number): Promise<string[]> {
    const logPath = this.getLogPath(runId);
    if (!existsSync(logPath)) return [];
    const content = await readFile(logPath, "utf8");
    return content.split("\n").filter((l) => l.length > 0);
  }
}

const logManager = new RunLogManager();

// Workspace discovery
async function findRepoDir(): Promise<string> {
  const home = os.homedir();
  const workDir = join(home, "work");
  const entries = await readdir(workDir, { withFileTypes: true });
  const repoDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("task-"));
  if (repoDirs.length === 0) {
    throw new Error("No repository clone found in ~/work");
  }
  return join(workDir, repoDirs[0].name);
}

// Git executor
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

// Active run state
interface ActiveRun {
  readonly runId: number;
  readonly containerName: string;
  readonly kill: () => Promise<void>;
}
const activeRuns = new Map<number, ActiveRun>();

export const handlers: { [V in RunnerVerb]: Handler<V> } = {
  status: async (_args, ctx) => ({
    project: ctx.project,
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
    activeRunIds: Array.from(activeRuns.keys()),
  }),

  streamLogs: async (args, ctx) => {
    const { runId } = args;
    const existing = await logManager.getExistingLines(runId);
    for (const line of existing) {
      ctx.emit({ type: "log", runId, line });
    }

    const isComplete = !activeRuns.has(runId);
    if (isComplete) {
      return { runId, complete: true };
    }

    const emitter = logManager.getEmitter(runId);
    return new Promise((resolve) => {
      const onLine = (line: string) => {
        ctx.emit({ type: "log", runId, line });
      };
      const onEnd = () => {
        emitter.off("line", onLine);
        resolve({ runId, complete: true });
      };
      emitter.on("line", onLine);
      emitter.once("end", onEnd);
    });
  },

  startRun: async (args, ctx) => {
    const { taskId, phase, provider, model, prompt } = args;

    // The runId is unique. Since SQLite runs table is the source of truth,
    // we use a timestamp-based ID or check the database. But the PM server
    // generates the runId and provides it? Wait! StartRunArgs does not carry
    // the runId!
    // Wait! Let's check StartRunArgs again. It does NOT have runId.
    // Wait! How does the runner know what runId to use?
    // Let's check the database table `runs` schema again.
    // When PM inserts a new run in the database, it gets an auto-incremented
    // ID (say runId = 12).
    // But how is it passed to the runner if it's not in StartRunArgs?
    // Wait, let's look at the database migrations and server routes!
    // Ah! Let's look at StartRunResult:
    // export interface StartRunResult {
    //   readonly runId: number;
    //   readonly status: "queued" | "running";
    // }
    // Wait! If the runner is the one that assigns the runId, then the runner
    // returns it!
    // But how can the runner assign a unique runId?
    // We can assign a unique runId using the current timestamp in ms,
    // or next sequential runId based on existing logs, or random number!
    // Wait! Let's check: can the runner read the existing run files in the task's
    // runs/ directory?
    // Yes! The task directory has a `runs/` folder containing `.md` files (like
    // `0001.md`, `0002.md`).
    // So the runner can read the next run number from the task's runs directory!
    // E.g.:
    // const runId = nextId(await readdir(join(task.dir, "runs")))
    // Let's verify:
    // Yes! `addRunOutcome` and `listRuns` in tasks.ts use the next sequential run number!
    // Let's check tasks.ts:
    // export async function addRunOutcome(task, frontMatter, outcome, opts) {
    //   const num = opts.num ?? nextId(await safeReaddir(dir));
    //   ...
    // }
    // This is perfect! The runId is exactly the run number for that task!
    // Let's implement this!

    await logManager.ensureLogDir();
    const repoDir = await findRepoDir();
    const pmDir = pmDirFor(repoDir);
    const task = await findTask(pmDir, taskId);
    if (!task) {
      throw new Error(`task ${taskId} not found`);
    }

    const runsDir = join(task.dir, "runs");
    await mkdir(runsDir, { recursive: true });
    // Determine the next runId (sequential for this task)
    const runFiles = (await readdir(runsDir)).filter((n) => n.endsWith(".md"));
    // parse leading id of files
    const runIds = runFiles.map((n) => parseInt(n.split("-")[0] || n.split(".")[0], 10)).filter((n) => !isNaN(n));
    const runId = runIds.length > 0 ? Math.max(...runIds) + 1 : 1;

    const branchName = `pm/task-${task.id}-${task.slug}`;
    const workspaceDir = join(os.homedir(), "work", `task-${task.id}-${task.slug}`);

    // Prune stale worktrees
    try {
      await runGit(["worktree", "prune"], repoDir);
    } catch {
      // ignore
    }

    // Check if worktree directory exists
    let worktreeExists = false;
    try {
      await stat(workspaceDir);
      worktreeExists = true;
    } catch {
      // does not exist
    }

    if (worktreeExists) {
      await runGit(["reset", "--hard", "HEAD"], workspaceDir);
      await runGit(["clean", "-fd"], workspaceDir);
    } else {
      const defaultBranch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
      let branchExists = false;
      try {
        await runGit(["rev-parse", "--verify", branchName], repoDir);
        branchExists = true;
      } catch {
        // does not exist
      }

      if (branchExists) {
        await runGit(["worktree", "add", workspaceDir, branchName], repoDir);
      } else {
        await runGit(["worktree", "add", "-b", branchName, workspaceDir, defaultBranch], repoDir);
      }
    }

    // Get adapter and command
    const adapter = getAdapter(provider);
    const cmd = adapter.containerCmd({ prompt, model });

    const containerName = `pm-agent-run-${runId}`;
    const dockerArgs = [
      "run",
      "--name",
      containerName,
      "--rm",
      "-v",
      `${workspaceDir}:/workspace`,
      "-v",
      `/run/user/${process.getuid ? process.getuid() : 0}/docker.sock:/var/run/docker.sock`,
      "-v",
      `${os.homedir()}/.ssh:/root/.ssh:ro`,
    ];

    // Read credentials
    const credsDir = join(os.homedir(), ".pm-creds");
    try {
      const files = await readdir(credsDir);
      for (const file of files) {
        const content = (await readFile(join(credsDir, file), "utf8")).trim();
        if (file === "claude" || file === "anthropic" || file === "oauth") {
          dockerArgs.push("-e", `ANTHROPIC_API_KEY=${content}`);
        }
        dockerArgs.push("-e", `${file.toUpperCase()}_API_KEY=${content}`);
        dockerArgs.push("-e", `${file.toUpperCase()}_TOKEN=${content}`);
      }
    } catch {
      // ignore
    }

    dockerArgs.push("pm-agent");
    dockerArgs.push(...cmd);

    // Spawn container
    const child = childProcess.spawn("docker", dockerArgs);

    // Track active run
    const killContainer = async () => {
      try {
        await execFileAsync("docker", ["stop", "-t", "10", containerName]);
      } catch {
        // ignore
      }
    };

    activeRuns.set(runId, {
      runId,
      containerName,
      kill: killContainer,
    });

    // Enforce 30 minute timeout
    const timeoutMs = 30 * 60 * 1000;
    const timer = setTimeout(() => {
      console.warn(`run ${runId} timed out after 30 minutes, stopping container`);
      void killContainer();
    }, timeoutMs);

    // Parse stdout/stderr
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line) void logManager.appendLine(runId, line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line) void logManager.appendLine(runId, `[stderr] ${line}`);
      }
    });

    // Run container in background, return StartRunResult immediately
    // Wait! If startRun returns immediately, we resolve this promise with { runId, status: "running" }
    // and let the child run in the background. When child closes, we clean up.
    child.on("close", (code) => {
      clearTimeout(timer);
      activeRuns.delete(runId);
      const emitter = logManager.getEmitter(runId);
      emitter.emit("end");
      logManager.deleteEmitter(runId);
      console.log(`run ${runId} container exited with code ${code}`);
    });

    return { runId, status: "running" };
  },

  stopRun: async (args) => {
    const { runId } = args;
    const active = activeRuns.get(runId);
    if (!active) {
      return { runId, stopped: false };
    }
    await active.kill();
    return { runId, stopped: true };
  },

  commitAndPush: async (args) => {
    const { branch } = args;
    const repoDir = await findRepoDir();

    if (!branch) {
      try {
        await runGit(["add", ".pm/"], repoDir);
        const status = await runGit(["status", "--porcelain"], repoDir);
        if (status.includes(".pm/")) {
          await runGit(["commit", "-m", "pm: update metadata"], repoDir);
          await runGit(["push", "origin", "HEAD"], repoDir);
        }
        return { branch: "", pushed: true };
      } catch (err) {
        console.error("commitAndPush default branch error:", err);
        return { branch: "", pushed: false };
      }
    } else {
      const match = branch.match(/^pm\/task-(\d+)-(.+)$/);
      if (!match) {
        throw new Error(`invalid task branch name: ${branch}`);
      }
      const taskId = parseInt(match[1], 10);
      const slug = match[2];
      const workspaceDir = join(os.homedir(), "work", `task-${taskId}-${slug}`);

      try {
        await runGit(["push", "origin", branch], workspaceDir);
        return { branch, pushed: true };
      } catch (err) {
        console.error(`commitAndPush branch ${branch} error:`, err);
        return { branch, pushed: false };
      }
    }
  },
};
