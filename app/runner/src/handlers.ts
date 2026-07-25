import { childProcess } from "./exec.js";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  findTask,
  getAdapter,
  pmDirFor,
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

/** Where ~/.pm-creds is mounted, read-only, inside the agent container. */
const CREDS_MOUNT = "/pm-creds";

/**
 * Credential file (written by pm-projectctl set-credential) → the environment
 * variable the agent CLI reads. The file names come from
 * PROVIDER_CREDENTIAL_KEYS in server/src/app.ts; adding a provider means
 * adding it in both places.
 *
 * TODO: ANTIGRAVITY_API_KEY is unverified — nobody has run `agy --help` on a
 * host yet (see docs/pm-remediation/README.md).
 */
const CREDENTIAL_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  antigravity: "ANTIGRAVITY_API_KEY",
};

/**
 * A `sh -c` preamble that loads the mounted credentials into the environment
 * and then `exec`s the real command. The value is read inside the container,
 * so it never appears in any argv the host can see.
 */
function credentialShim(): string {
  const lines = Object.entries(CREDENTIAL_ENV).map(
    ([file, env]) =>
      `if [ -r ${CREDS_MOUNT}/${file} ]; then ${env}="$(cat ${CREDS_MOUNT}/${file})"; export ${env}; fi`,
  );
  return [...lines, 'exec "$@"'].join("\n");
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

function stripHostPorts(services: any) {
  if (!services || typeof services !== "object") return;
  for (const key of Object.keys(services)) {
    const svc = services[key];
    if (svc && svc.ports && Array.isArray(svc.ports)) {
      svc.ports = svc.ports.map((p: any) => {
        if (typeof p === "string") {
          const parts = p.split(":");
          return parts[parts.length - 1];
        } else if (p && typeof p === "object") {
          const copy = { ...p };
          delete copy.published;
          delete copy.host_ip;
          return copy;
        }
        return p;
      });
    }
  }
}

function runCommandWithLogging(
  cmd: string,
  args: string[],
  cwd: string,
  runId: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line) void logManager.appendLine(runId, line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line) void logManager.appendLine(runId, `[stderr] ${line}`);
      }
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
    child.on("error", (err) => {
      reject(err);
    });
  });
}

async function collectArtifacts(opts: {
  readonly verifyDir: string;
  readonly e2eContainerName: string;
  readonly hasE2E: boolean;
  readonly task: any;
  readonly runId: number;
  readonly log: (message: string) => Promise<void>;
}): Promise<void> {
  const { verifyDir, e2eContainerName, hasE2E, task, runId, log } = opts;
  const pmArtifactsDir = join(verifyDir, "pm-artifacts");

  // Create verify-artifacts directory inside .pm folder
  const repoPmDir = pmDirFor(await findRepoDir());
  const runArtifactsDir = join(repoPmDir, "verify-artifacts", String(runId));
  await mkdir(runArtifactsDir, { recursive: true });
  // Add .gitignore containing * to verify-artifacts
  await writeFile(join(repoPmDir, "verify-artifacts", ".gitignore"), "*\n", "utf8");

  // Determine if host folder has files
  let hasHostArtifacts = false;
  try {
    const files = await readdir(pmArtifactsDir);
    if (files.length > 0) hasHostArtifacts = true;
  } catch {
    // ignore
  }

  if (!hasHostArtifacts && hasE2E) {
    // Try copying from e2e container
    await log(`[verify] Checking for artifacts in container ${e2eContainerName}...`);
    const pathsToTry = [
      "/pm-artifacts",
      "/workspace/pm-artifacts",
      "/app/pm-artifacts",
      "/usr/src/app/pm-artifacts",
    ];
    for (const p of pathsToTry) {
      try {
        await mkdir(pmArtifactsDir, { recursive: true });
        await execFileAsync("docker", ["cp", `${e2eContainerName}:${p}/.`, pmArtifactsDir]);
        await log(`[verify] Copied artifacts from container path: ${p}`);
        hasHostArtifacts = true;
        break;
      } catch {
        // ignore
      }
    }
  }

  if (hasHostArtifacts) {
    await log("[verify] Collecting and processing artifacts...");
    const files = await readdir(pmArtifactsDir);
    const attachmentsDir = join(task.dir, "attachments");
    await mkdir(attachmentsDir, { recursive: true });

    for (const file of files) {
      const srcPath = join(pmArtifactsDir, file);
      const ext = file.split(".").pop()?.toLowerCase();

      // If it's a video, attempt conversion to GIF via ffmpeg inside docker
      if (ext === "webm" || ext === "mp4") {
        const gifFile = file.substring(0, file.lastIndexOf(".")) + ".gif";
        const gifDestPath = join(runArtifactsDir, gifFile);
        const webmDestPath = join(runArtifactsDir, file);

        // Copy the raw video file
        try {
          await execFileAsync("cp", [srcPath, webmDestPath]);
        } catch {
          // ignore
        }

        // Run conversion using docker container with static-ffmpeg
        await log(`[verify] Converting video ${file} to GIF...`);
        try {
          await execFileAsync("docker", [
            "run",
            "--rm",
            "-v",
            `${pmArtifactsDir}:/artifacts`,
            "mwader/static-ffmpeg:6.1.1",
            "-i",
            `/artifacts/${file}`,
            "-vf",
            "fps=10,scale=480:-1:flags=lanczos",
            "-c:v",
            "gif",
            `/artifacts/${gifFile}`,
          ]);
          // Copy converted GIF to runs directory
          await execFileAsync("cp", [join(pmArtifactsDir, gifFile), gifDestPath]);
          await log(`[verify] Converted and saved GIF: ${gifFile}`);
        } catch (err: any) {
          await log(`[verify] Warning: video conversion failed: ${err.message}. Copying raw video only.`);
        }
      } else {
        // For other files (e.g. screenshots), copy to runArtifactsDir
        const destPath = join(runArtifactsDir, file);
        try {
          await execFileAsync("cp", [srcPath, destPath]);
        } catch {
          // ignore
        }

        // "copy small final screenshots into the run's attachments"
        if (ext === "png" || ext === "jpg" || ext === "jpeg") {
          const attachmentFilename = `verify-${runId}-${file}`;
          const attachmentDestPath = join(attachmentsDir, attachmentFilename);
          try {
            await execFileAsync("cp", [srcPath, attachmentDestPath]);
            await log(`[verify] Copied screenshot to task attachments: ${attachmentFilename}`);
          } catch {
            // ignore
          }
        }
      }
    }
  }
}

async function executeVerify(opts: {
  readonly runId: number;
  readonly taskId: number;
  readonly projectName: string;
  readonly repoDir: string;
  readonly task: any;
  readonly branchName: string;
}): Promise<void> {
  const { runId, taskId, projectName, repoDir, task, branchName } = opts;
  const log = async (message: string) => {
    await logManager.appendLine(runId, message);
  };
  const logJson = async (obj: any) => {
    await logManager.appendLine(runId, JSON.stringify(obj));
  };

  const verifyDir = join(os.homedir(), "work", `verify-${taskId}-${runId}`);
  const uniqueProjectName = `pm-verify-${projectName}-${taskId}-${runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");

  await log(`[verify] Starting verification for project ${projectName}, task ${taskId} on branch ${branchName}...`);

  let success = false;
  let summary = "";

  try {
    // 1. Clean up/recreate verify directory
    await rm(verifyDir, { recursive: true, force: true });
    await mkdir(verifyDir, { recursive: true });

    // 2. Clone repository to verifyDir and check out the task branch
    await log(`[verify] Cloning repo to ${verifyDir}...`);
    await execFileAsync("git", ["clone", repoDir, verifyDir]);
    await log(`[verify] Checking out branch: ${branchName}...`);
    await execFileAsync("git", ["checkout", branchName], { cwd: verifyDir });

    // 3. Find and parse compose file
    let composeFile = "";
    for (const name of ["compose.yaml", "docker-compose.yml"]) {
      if (existsSync(join(verifyDir, name))) {
        composeFile = name;
        break;
      }
    }

    if (!composeFile) {
      throw new Error("No compose.yaml or docker-compose.yml found at the root of the repository");
    }

    await log(`[verify] Found compose file: ${composeFile}`);
    const composeContent = await readFile(join(verifyDir, composeFile), "utf8");
    const doc = parse(composeContent);
    if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
      throw new Error("Invalid or empty compose file (no services defined)");
    }

    // Strip host ports from all services
    stripHostPorts(doc.services);

    const verifyComposeFile = "compose.verify.yaml";
    await writeFile(join(verifyDir, verifyComposeFile), stringify(doc), "utf8");
    await log(`[verify] Created compose.verify.yaml without host port bindings`);

    // 4. Start services via docker compose up --wait --build
    await log(`[verify] Building and starting services via docker compose up...`);
    const upRes = await runCommandWithLogging(
      "docker",
      ["compose", "-p", uniqueProjectName, "-f", verifyComposeFile, "up", "--wait", "--build"],
      verifyDir,
      runId
    );

    if (upRes.code !== 0) {
      throw new Error(`docker compose up failed with exit code ${upRes.code}`);
    }
    await log(`[verify] Services are up and healthy.`);

    // 5. Run test service if present
    const services = doc.services;
    const hasTest = Object.prototype.hasOwnProperty.call(services, "test");
    const hasE2E = Object.prototype.hasOwnProperty.call(services, "e2e");

    if (hasTest) {
      await log(`[verify] Running tests via test service...`);
      const testRes = await runCommandWithLogging(
        "docker",
        ["compose", "-p", uniqueProjectName, "-f", verifyComposeFile, "run", "--rm", "test"],
        verifyDir,
        runId
      );
      if (testRes.code !== 0) {
        throw new Error(`Test suite service failed with exit code ${testRes.code}`);
      }
      await log(`[verify] Test suite service passed.`);
    }

    // 6. Run e2e service if present
    const e2eContainerName = `${uniqueProjectName}-e2e-run`;
    if (hasE2E) {
      await log(`[verify] Running E2E tests via e2e service...`);
      const e2eRes = await runCommandWithLogging(
        "docker",
        ["compose", "-p", uniqueProjectName, "-f", verifyComposeFile, "run", "--name", e2eContainerName, "e2e"],
        verifyDir,
        runId
      );
      if (e2eRes.code !== 0) {
        throw new Error(`E2E tests service failed with exit code ${e2eRes.code}`);
      }
      await log(`[verify] E2E tests service passed.`);
    }

    // 7. Collect artifacts
    await collectArtifacts({
      verifyDir,
      e2eContainerName,
      hasE2E,
      task,
      runId,
      log,
    });

    success = true;
    summary = "Verification completed successfully. All tests and checks passed.";
  } catch (err: any) {
    await log(`[verify] Verification failed: ${err.message}`);
    summary = `Verification failed: ${err.message}`;
  } finally {
    // 8. Teardown
    await log(`[verify] Tearing down docker compose stack...`);
    try {
      await execFileAsync("docker", ["compose", "-p", uniqueProjectName, "down", "-v"]);
    } catch (err: any) {
      await log(`[verify] Error during docker compose down: ${err.message}`);
    }

    try {
      await execFileAsync("docker", ["rm", "-f", `${uniqueProjectName}-e2e-run`]);
    } catch {
      // ignore
    }

    // Clean up temporary checkouts
    try {
      await rm(verifyDir, { recursive: true, force: true });
    } catch (err: any) {
      await log(`[verify] Error cleaning up verify workspace: ${err.message}`);
    }

    // Write final outcome result JSON event so server parses it
    if (success) {
      await logJson({
        type: "result",
        subtype: "success",
        result: summary,
      });
    } else {
      await logJson({
        type: "result",
        subtype: "failure",
        result: summary,
      });
    }

    // Terminate log emitter
    const emitter = logManager.getEmitter(runId);
    emitter.emit("end");
    logManager.deleteEmitter(runId);
  }
}

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

    if (phase === "verify") {
      void executeVerify({
        runId,
        taskId,
        projectName: ctx.project,
        repoDir,
        task,
        branchName,
      });
      return { runId, status: "running" };
    }

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

    // Credentials reach the agent as a read-only mount, never on argv:
    // process arguments are world-readable in /proc, so `-e KEY=value` would
    // hand every user on the host the provider token for the length of a run.
    const credsDir = join(os.homedir(), ".pm-creds");
    if (existsSync(credsDir)) {
      dockerArgs.push("-v", `${credsDir}:${CREDS_MOUNT}:ro`);
    }

    dockerArgs.push("pm-agent");
    // The shim reads each mounted file inside the container and exports it
    // under the name that CLI actually looks for — an explicit mapping, not
    // the old fan-out that guessed at <FILE>_API_KEY and <FILE>_TOKEN. It is
    // harmless without the mount: each export is guarded by a readability test.
    dockerArgs.push("/bin/sh", "-c", credentialShim(), "pm-agent");
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

      if (phase !== "implement") {
        runGit(["reset", "--hard", "HEAD"], workspaceDir)
          .then(() => runGit(["clean", "-fd"], workspaceDir))
          .then(() => console.log(`run ${runId} workspace reset successfully`))
          .catch((err) => console.error(`run ${runId} workspace reset failed:`, err));
      }
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
