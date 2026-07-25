import { childProcess } from "./exec.js";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  findTask,
  getAdapter,
  pmDirFor,
  setTaskBranch,
  type RunnerEvent,
  type RunnerVerb,
  type RunnerVerbs,
  type TaskRecord,
} from "@pm/core";

const execFileAsync = (file: string, args: string[], opts?: ExecFileOptions) =>
  childProcess.execFileAsync(file, args, opts);

/** Extracts a human-readable message from an unknown catch value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
 * Services a project's compose file may define that are expected to run once
 * and exit. They must be excluded from `compose up --wait`, which treats an
 * immediately-exiting container as a failed start.
 */
const ONE_SHOT_SERVICES = ["test", "e2e"];

/** Compose project prefix for the throwaway environments verify/review create. */
const EPHEMERAL_COMPOSE_PREFIX = "pm-verify-";

/** Directory-name prefixes under ~/work that are *not* the project repo. */
const EPHEMERAL_WORK_PREFIXES = ["task-", "verify-", "review-"];

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

function defaultRunTimeoutMs(): number {
  return Number(process.env.PM_RUN_TIMEOUT_MS) || DEFAULT_RUN_TIMEOUT_MS;
}

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
  /**
   * One promise chain per run. Every append links onto its run's chain, so
   * concurrent stdout/stderr chunks can never interleave inside the file and
   * `end` can wait for the last write to land.
   */
  private readonly writes = new Map<number, Promise<void>>();
  private readonly seqs = new Map<number, number>();
  private readonly exitCodes = new Map<number, number | null>();

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

  appendLine(runId: number, line: string): Promise<void> {
    const emitter = this.getEmitter(runId);
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    const logPath = this.getLogPath(runId);
    const next = (this.writes.get(runId) ?? Promise.resolve())
      .then(() => appendFile(logPath, `${line}\n`))
      .catch((err) => {
        console.error(`run ${runId}: failed to append to ${logPath}:`, err);
      })
      .then(() => {
        emitter.emit("line", line, seq);
      });
    this.writes.set(runId, next);
    return next;
  }

  /** Resolves once every append queued before this call has hit the file. */
  async drain(runId: number): Promise<void> {
    let pending = this.writes.get(runId);
    while (pending) {
      await pending;
      const latest = this.writes.get(runId);
      if (latest === pending) return;
      pending = latest;
    }
  }

  /** Flushes the log, records the exit code, then closes the stream. */
  async endRun(runId: number, exitCode: number | null): Promise<void> {
    await this.drain(runId);
    this.setExitCode(runId, exitCode);
    this.writes.delete(runId);
    this.seqs.delete(runId);
    const emitter = this.getEmitter(runId);
    emitter.emit("end");
    this.deleteEmitter(runId);
  }

  setExitCode(runId: number, exitCode: number | null): void {
    this.exitCodes.set(runId, exitCode);
    // Bounded memory: a runner that has been up for weeks should not hold
    // every exit code it ever saw.
    if (this.exitCodes.size > 500) {
      const oldest = this.exitCodes.keys().next();
      if (!oldest.done) this.exitCodes.delete(oldest.value);
    }
  }

  exitCode(runId: number): number | null {
    return this.exitCodes.get(runId) ?? null;
  }

  async getExistingLines(runId: number): Promise<string[]> {
    const logPath = this.getLogPath(runId);
    if (!existsSync(logPath)) return [];
    const content = await readFile(logPath, "utf8");
    return content.split("\n").filter((l) => l.length > 0);
  }
}

const logManager = new RunLogManager();

/**
 * The project's repo checkout.
 *
 * pm-projectctl's runner unit exports PM_REPO_DIR and that is authoritative:
 * guessing from ~/work is unsafe because verify/review create throwaway
 * checkouts as siblings of the repo. The fallback exists only for a runner
 * started by hand, and refuses to choose when the answer is ambiguous.
 */
async function resolveRepoDir(): Promise<string> {
  const fromEnv = process.env.PM_REPO_DIR;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`PM_REPO_DIR points at ${fromEnv}, which does not exist`);
    }
    return fromEnv;
  }
  const workDir = join(os.homedir(), "work");
  const entries = await readdir(workDir, { withFileTypes: true });
  const candidates = entries.filter(
    (e) => e.isDirectory() && !EPHEMERAL_WORK_PREFIXES.some((p) => e.name.startsWith(p)),
  );
  if (candidates.length === 0) {
    throw new Error("PM_REPO_DIR is not set and no repository clone was found in ~/work");
  }
  if (candidates.length > 1) {
    throw new Error(
      `PM_REPO_DIR is not set and ~/work is ambiguous (${candidates.map((c) => c.name).join(", ")})`,
    );
  }
  return join(workDir, candidates[0].name);
}

/**
 * Git needs the project's deploy key for anything that touches the remote;
 * the runner unit exports its path as PM_DEPLOY_KEY.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const key = process.env.PM_DEPLOY_KEY;
  if (!key) return process.env;
  return {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };
}

// Git executor
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv() });
  return stdout.trim();
}

async function isDirty(cwd: string): Promise<boolean> {
  return (await runGit(["status", "--porcelain"], cwd)).length > 0;
}

// Active run state
interface ActiveRun {
  readonly runId: number;
  readonly containerName: string;
  readonly kill: () => Promise<void>;
}
const activeRuns = new Map<number, ActiveRun>();

/**
 * A cancellable multi-step run (verify, review). `stopRun` flips `cancelled`,
 * kills whatever child process is in flight, and fires the registered
 * teardowns; every step checks `cancelled` before starting the next one.
 */
class RunJob {
  cancelled = false;
  private child: ChildProcess | null = null;
  private readonly teardowns: (() => Promise<void>)[] = [];

  setChild(child: ChildProcess): void {
    this.child = child;
    if (this.cancelled) this.killChild();
  }

  clearChild(): void {
    this.child = null;
  }

  onCancel(fn: () => Promise<void>): void {
    this.teardowns.push(fn);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.killChild();
    for (const fn of this.teardowns.splice(0)) {
      try {
        await fn();
      } catch {
        // teardown is best-effort
      }
    }
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new Error("run was cancelled");
  }

  private killChild(): void {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

interface ComposeService {
  ports?: unknown[];
  [key: string]: unknown;
}

function stripHostPorts(services: unknown): void {
  if (!services || typeof services !== "object") return;
  for (const svc of Object.values(services as Record<string, ComposeService>)) {
    if (!svc || !Array.isArray(svc.ports)) continue;
    svc.ports = svc.ports.map((p: unknown) => {
      if (typeof p === "string") {
        const parts = p.split(":");
        return parts[parts.length - 1];
      } else if (p && typeof p === "object") {
        const copy = { ...(p as Record<string, unknown>) };
        delete copy.published;
        delete copy.host_ip;
        return copy;
      }
      return p;
    });
  }
}

function runCommandWithLogging(
  cmd: string,
  args: string[],
  cwd: string,
  runId: number,
  opts: { readonly onChild?: (child: ChildProcess) => void; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(cmd, args, opts.env ? { cwd, env: opts.env } : { cwd });
    opts.onChild?.(child);
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

// ─── Ephemeral project environments (verify + review) ────────────────────────

interface ComposeEnv {
  readonly composeProject: string;
  readonly composeFile: string;
  readonly services: Record<string, unknown>;
  readonly hasTest: boolean;
  readonly hasE2E: boolean;
  /** Services that stay up: everything except the one-shot ones. */
  readonly longRunning: string[];
  down: () => Promise<void>;
}

function ephemeralComposeProject(projectName: string, taskId: number, runId: number): string {
  return `${EPHEMERAL_COMPOSE_PREFIX}${projectName}-${taskId}-${runId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * Clones the *pushed* branch from origin — verify and review must see what the
 * remote has, not whatever the local checkout happens to contain.
 */
async function cloneBranchFromOrigin(opts: {
  readonly repoDir: string;
  readonly targetDir: string;
  readonly branch: string;
  readonly log: (message: string) => Promise<void>;
}): Promise<void> {
  const { repoDir, targetDir, branch, log } = opts;
  const origin = await runGit(["remote", "get-url", "origin"], repoDir);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await log(`[env] Cloning ${origin} (branch ${branch}) into ${targetDir}...`);
  await execFileAsync("git", ["clone", "--branch", branch, origin, targetDir], { env: gitEnv() });
}

/**
 * Reads the project's compose file, strips host port bindings (several runs
 * share one host) and writes the rewritten file next to the original.
 */
async function prepareComposeEnv(opts: {
  readonly dir: string;
  readonly composeProject: string;
  readonly log: (message: string) => Promise<void>;
}): Promise<ComposeEnv> {
  const { dir, composeProject, log } = opts;

  let sourceFile = "";
  for (const name of ["compose.yaml", "docker-compose.yml"]) {
    if (existsSync(join(dir, name))) {
      sourceFile = name;
      break;
    }
  }
  if (!sourceFile) {
    throw new Error("No compose.yaml or docker-compose.yml found at the root of the repository");
  }

  await log(`[env] Found compose file: ${sourceFile}`);
  const doc = parse(await readFile(join(dir, sourceFile), "utf8"));
  if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
    throw new Error("Invalid or empty compose file (no services defined)");
  }

  stripHostPorts(doc.services);
  const composeFile = "compose.verify.yaml";
  await writeFile(join(dir, composeFile), stringify(doc), "utf8");
  await log("[env] Wrote compose.verify.yaml without host port bindings");

  const services = doc.services as Record<string, unknown>;
  const names = Object.keys(services);

  const env: ComposeEnv = {
    composeProject,
    composeFile,
    services,
    hasTest: names.includes("test"),
    hasE2E: names.includes("e2e"),
    longRunning: names.filter((n) => !ONE_SHOT_SERVICES.includes(n)),
    // Always tear down with an explicit -f and cwd: the verify directory is
    // about to be deleted, and `compose down` from the runner's own cwd finds
    // no configuration at all.
    down: async () => {
      await execFileAsync(
        "docker",
        ["compose", "-p", composeProject, "-f", composeFile, "down", "-v", "--remove-orphans"],
        { cwd: dir },
      );
    },
  };
  return env;
}

/**
 * `compose up --wait` on the long-running services only. Naming them
 * explicitly is what keeps `--wait` from blocking on `test`/`e2e`, which exit
 * as soon as they finish and which Compose then reports as a failed start.
 */
async function startComposeEnv(opts: {
  readonly env: ComposeEnv;
  readonly dir: string;
  readonly runId: number;
  readonly job: RunJob;
  readonly log: (message: string) => Promise<void>;
}): Promise<void> {
  const { env, dir, runId, job, log } = opts;
  if (env.longRunning.length === 0) {
    await log("[env] No long-running services to start.");
    return;
  }
  await log(`[env] Building and starting services: ${env.longRunning.join(", ")}...`);
  const res = await runCommandWithLogging(
    "docker",
    [
      "compose",
      "-p",
      env.composeProject,
      "-f",
      env.composeFile,
      "up",
      "--wait",
      "--build",
      ...env.longRunning,
    ],
    dir,
    runId,
    { onChild: (child) => job.setChild(child) },
  );
  job.clearChild();
  if (res.code !== 0) {
    throw new Error(`docker compose up failed with exit code ${res.code}`);
  }
  await log("[env] Services are up and healthy.");
}

/** The network an agent container must join to reach the started services. */
async function composeNetwork(composeProject: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.Name}}",
    ]);
    const names = String(stdout)
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length > 0) return names[0];
  } catch {
    // fall through
  }
  return null;
}

async function collectArtifacts(opts: {
  readonly verifyDir: string;
  readonly repoDir: string;
  readonly e2eContainerName: string;
  readonly hasE2E: boolean;
  readonly task: TaskRecord;
  readonly runId: number;
  readonly log: (message: string) => Promise<void>;
}): Promise<void> {
  const { verifyDir, repoDir, e2eContainerName, hasE2E, task, runId, log } = opts;
  const pmArtifactsDir = join(verifyDir, "pm-artifacts");

  // Create verify-artifacts directory inside .pm folder
  const repoPmDir = pmDirFor(repoDir);
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
        } catch (err) {
          await log(`[verify] Warning: video conversion failed: ${errMessage(err)}. Copying raw video only.`);
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
  readonly task: TaskRecord;
  readonly branchName: string;
  readonly job: RunJob;
  readonly timeoutMs: number;
}): Promise<void> {
  const { runId, taskId, projectName, repoDir, task, branchName, job, timeoutMs } = opts;
  const log = async (message: string) => {
    await logManager.appendLine(runId, message);
  };
  const logJson = async (obj: { type: string; subtype: string; result: string }) => {
    await logManager.appendLine(runId, JSON.stringify(obj));
  };

  const verifyDir = join(os.homedir(), "work", `verify-${taskId}-${runId}`);
  const composeProject = ephemeralComposeProject(projectName, taskId, runId);

  await log(`[verify] Starting verification for project ${projectName}, task ${taskId} on branch ${branchName}...`);

  let success = false;
  let summary = "";
  let env: ComposeEnv | null = null;

  const timer = setTimeout(() => {
    void log(`[verify] Timed out after ${Math.round(timeoutMs / 60000)} minutes, cancelling.`).then(() =>
      job.cancel(),
    );
  }, timeoutMs);

  try {
    job.throwIfCancelled();
    await cloneBranchFromOrigin({ repoDir, targetDir: verifyDir, branch: branchName, log });

    job.throwIfCancelled();
    env = await prepareComposeEnv({ dir: verifyDir, composeProject, log });
    const startedEnv = env;
    job.onCancel(async () => {
      await startedEnv.down();
    });

    await startComposeEnv({ env, dir: verifyDir, runId, job, log });

    if (env.hasTest) {
      job.throwIfCancelled();
      await log("[verify] Running tests via test service...");
      const testRes = await runCommandWithLogging(
        "docker",
        ["compose", "-p", composeProject, "-f", env.composeFile, "run", "--rm", "test"],
        verifyDir,
        runId,
        { onChild: (child) => job.setChild(child) },
      );
      job.clearChild();
      if (testRes.code !== 0) {
        throw new Error(`Test suite service failed with exit code ${testRes.code}`);
      }
      await log("[verify] Test suite service passed.");
    }

    const e2eContainerName = `${composeProject}-e2e-run`;
    if (env.hasE2E) {
      job.throwIfCancelled();
      await log("[verify] Running E2E tests via e2e service...");
      const e2eRes = await runCommandWithLogging(
        "docker",
        ["compose", "-p", composeProject, "-f", env.composeFile, "run", "--name", e2eContainerName, "e2e"],
        verifyDir,
        runId,
        { onChild: (child) => job.setChild(child) },
      );
      job.clearChild();
      if (e2eRes.code !== 0) {
        throw new Error(`E2E tests service failed with exit code ${e2eRes.code}`);
      }
      await log("[verify] E2E tests service passed.");
    }

    await collectArtifacts({
      verifyDir,
      repoDir,
      e2eContainerName,
      hasE2E: env.hasE2E,
      task,
      runId,
      log,
    });

    success = true;
    summary = "Verification completed successfully. All tests and checks passed.";
  } catch (err) {
    const message = job.cancelled ? "run was cancelled" : errMessage(err);
    await log(`[verify] Verification failed: ${message}`);
    summary = `Verification failed: ${message}`;
  } finally {
    clearTimeout(timer);

    await log("[verify] Tearing down docker compose stack...");
    if (env) {
      try {
        await env.down();
      } catch (err) {
        await log(`[verify] Error during docker compose down: ${errMessage(err)}`);
      }
    }
    try {
      await execFileAsync("docker", ["rm", "-f", `${composeProject}-e2e-run`]);
    } catch {
      // ignore
    }

    try {
      await rm(verifyDir, { recursive: true, force: true });
    } catch (err) {
      await log(`[verify] Error cleaning up verify workspace: ${errMessage(err)}`);
    }

    await logJson({
      type: "result",
      subtype: success ? "success" : "failure",
      result: summary,
    });

    activeRuns.delete(runId);
    await logManager.endRun(runId, success ? 0 : 1);
  }
}

// ─── Agent containers ────────────────────────────────────────────────────────

function agentDockerArgs(opts: {
  readonly containerName: string;
  readonly workspaceDir: string;
  readonly cmd: readonly string[];
  readonly network?: string | null;
}): string[] {
  const args = [
    "run",
    "--name",
    opts.containerName,
    "--rm",
    "-v",
    `${opts.workspaceDir}:/workspace`,
    "-v",
    `/run/user/${process.getuid ? process.getuid() : 0}/docker.sock:/var/run/docker.sock`,
    "-v",
    `${os.homedir()}/.ssh:/root/.ssh:ro`,
  ];

  if (opts.network) {
    args.push("--network", opts.network);
  }

  // Credentials reach the agent as a read-only mount, never on argv:
  // process arguments are world-readable in /proc, so `-e KEY=value` would
  // hand every user on the host the provider token for the length of a run.
  const credsDir = process.env.PM_CREDS_DIR || join(os.homedir(), ".pm-creds");
  if (existsSync(credsDir)) {
    args.push("-v", `${credsDir}:${CREDS_MOUNT}:ro`);
  }

  args.push("pm-agent");
  // The shim reads each mounted file inside the container and exports it
  // under the name that CLI actually looks for — an explicit mapping, not
  // the old fan-out that guessed at <FILE>_API_KEY and <FILE>_TOKEN. It is
  // harmless without the mount: each export is guarded by a readability test.
  args.push("/bin/sh", "-c", credentialShim(), "pm-agent");
  args.push(...opts.cmd);
  return args;
}

/**
 * Spawns the agent container and streams it into the run log. Resolves with
 * the container's exit code; does not touch `activeRuns` or end the log —
 * callers own the run's lifecycle because they differ in what has to be torn
 * down afterwards.
 */
function spawnAgentContainer(opts: {
  readonly runId: number;
  readonly containerName: string;
  readonly workspaceDir: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly network?: string | null;
}): Promise<number | null> {
  const adapter = getAdapter(opts.provider);
  const cmd = adapter.containerCmd({ prompt: opts.prompt, model: opts.model });
  const dockerArgs = agentDockerArgs({
    containerName: opts.containerName,
    workspaceDir: opts.workspaceDir,
    cmd,
    network: opts.network,
  });

  const child = childProcess.spawn("docker", dockerArgs);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line) void logManager.appendLine(opts.runId, line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line) void logManager.appendLine(opts.runId, `[stderr] ${line}`);
    }
  });

  return new Promise((resolve) => {
    child.on("close", (code: number | null) => resolve(code));
    child.on("error", (err: Error) => {
      void logManager.appendLine(opts.runId, `[stderr] failed to start container: ${errMessage(err)}`);
      resolve(null);
    });
  });
}

async function stopContainer(containerName: string): Promise<void> {
  try {
    await execFileAsync("docker", ["stop", "-t", "10", containerName]);
  } catch {
    // already gone
  }
}

/**
 * Review, per the plan: a *fresh* checkout of the pushed branch with the
 * project's environment running, so the agent can actually poke the app it is
 * reviewing. Nothing here touches the task worktree.
 */
async function executeReview(opts: {
  readonly runId: number;
  readonly taskId: number;
  readonly projectName: string;
  readonly repoDir: string;
  readonly branchName: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly job: RunJob;
  readonly timeoutMs: number;
}): Promise<void> {
  const { runId, taskId, projectName, repoDir, branchName, job, timeoutMs } = opts;
  const log = async (message: string) => {
    await logManager.appendLine(runId, message);
  };

  const reviewDir = join(os.homedir(), "work", `review-${taskId}-${runId}`);
  const composeProject = ephemeralComposeProject(projectName, taskId, runId);
  const containerName = `pm-agent-run-${runId}`;
  let env: ComposeEnv | null = null;
  let exitCode: number | null = null;

  const timer = setTimeout(() => {
    void log(`[review] Timed out after ${Math.round(timeoutMs / 60000)} minutes, cancelling.`).then(() =>
      job.cancel(),
    );
  }, timeoutMs);

  try {
    job.throwIfCancelled();
    await cloneBranchFromOrigin({ repoDir, targetDir: reviewDir, branch: branchName, log });

    // A project without a usable compose file is still reviewable — the agent
    // just gets a checkout and no running app.
    try {
      job.throwIfCancelled();
      env = await prepareComposeEnv({ dir: reviewDir, composeProject, log });
      const startedEnv = env;
      job.onCancel(async () => {
        await startedEnv.down();
      });
      await startComposeEnv({ env, dir: reviewDir, runId, job, log });
    } catch (err) {
      await log(`[review] Could not start the project environment: ${errMessage(err)}`);
      if (job.cancelled) throw err;
    }

    job.throwIfCancelled();
    const network = env && env.longRunning.length > 0 ? await composeNetwork(composeProject) : null;
    if (network) {
      await log(`[review] Agent container joins network ${network}.`);
    }

    job.onCancel(async () => {
      await stopContainer(containerName);
    });

    exitCode = await spawnAgentContainer({
      runId,
      containerName,
      workspaceDir: reviewDir,
      provider: opts.provider,
      model: opts.model,
      prompt: opts.prompt,
      network,
    });
  } catch (err) {
    const message = job.cancelled ? "run was cancelled" : errMessage(err);
    await log(`[review] Review run failed: ${message}`);
    exitCode = exitCode ?? 1;
  } finally {
    clearTimeout(timer);

    if (env) {
      await log("[review] Tearing down the project environment...");
      try {
        await env.down();
      } catch (err) {
        await log(`[review] Error during docker compose down: ${errMessage(err)}`);
      }
    }
    try {
      await rm(reviewDir, { recursive: true, force: true });
    } catch (err) {
      await log(`[review] Error cleaning up review workspace: ${errMessage(err)}`);
    }

    activeRuns.delete(runId);
    await logManager.endRun(runId, job.cancelled ? (exitCode ?? 143) : exitCode);
  }
}

/**
 * Prepares the task worktree without ever discarding work. An earlier run that
 * left changes uncommitted (an agent that forgot, a run that was killed) gets
 * them committed onto the task branch rather than reset away.
 */
async function prepareWorktree(opts: {
  readonly repoDir: string;
  readonly workspaceDir: string;
  readonly branchName: string;
  readonly runId: number;
}): Promise<void> {
  const { repoDir, workspaceDir, branchName, runId } = opts;

  try {
    await runGit(["worktree", "prune"], repoDir);
  } catch {
    // a repo with no worktrees at all is fine
  }

  let worktreeExists = false;
  try {
    await stat(workspaceDir);
    worktreeExists = true;
  } catch {
    // does not exist
  }

  if (worktreeExists) {
    if (await isDirty(workspaceDir)) {
      await logManager.appendLine(
        runId,
        "[runner] Worktree had uncommitted changes from a previous run; committing them before starting.",
      );
      await runGit(["add", "-A"], workspaceDir);
      await runGit(["commit", "-m", "pm: recover uncommitted work from a previous run"], workspaceDir);
    }
    return;
  }

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

/**
 * Read-only phases are told not to modify the workspace. If one did anyway,
 * stash the changes: they stay recoverable without polluting the task branch,
 * and the next run still starts from a clean tree.
 */
async function stashStrayChanges(workspaceDir: string, runId: number, phase: string): Promise<void> {
  try {
    if (!(await isDirty(workspaceDir))) return;
    await runGit(["stash", "push", "-u", "-m", `pm: stray changes from ${phase} run ${runId}`], workspaceDir);
    console.log(`run ${runId} stashed stray changes left by the ${phase} phase`);
  } catch (err) {
    console.error(`run ${runId} could not stash stray changes:`, err);
  }
}

// ─── Verb handlers ───────────────────────────────────────────────────────────

export const handlers: { [V in RunnerVerb]: Handler<V> } = {
  status: async (_args, ctx) => ({
    project: ctx.project,
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
    activeRunIds: Array.from(activeRuns.keys()),
  }),

  streamLogs: async (args, ctx) => {
    const { runId } = args;
    const emitter = logManager.getEmitter(runId);

    // Subscribe before reading the file so nothing written during the read is
    // lost; the sequence number tells us which buffered lines the snapshot
    // already contained.
    const buffered: { seq: number; line: string }[] = [];
    let flushed = 0;
    let live = false;
    const onLine = (line: string, seq: number) => {
      if (!live) {
        buffered.push({ seq, line });
        return;
      }
      if (seq > flushed) ctx.emit({ type: "log", runId, line });
    };
    emitter.on("line", onLine);

    try {
      await logManager.drain(runId);
      const existing = await logManager.getExistingLines(runId);
      for (const line of existing) {
        ctx.emit({ type: "log", runId, line });
      }
      flushed = existing.length;
      for (const item of buffered) {
        if (item.seq > flushed) ctx.emit({ type: "log", runId, line: item.line });
      }
      live = true;

      if (!activeRuns.has(runId)) {
        emitter.off("line", onLine);
        return { runId, complete: true, exitCode: logManager.exitCode(runId) };
      }
    } catch (err) {
      emitter.off("line", onLine);
      throw err;
    }

    return new Promise((resolve) => {
      emitter.once("end", () => {
        emitter.off("line", onLine);
        resolve({ runId, complete: true, exitCode: logManager.exitCode(runId) });
      });
    });
  },

  startRun: async (args, ctx) => {
    const { runId, taskId, phase, provider, model, prompt } = args;
    if (typeof runId !== "number" || !Number.isFinite(runId)) {
      throw new Error("startRun requires a numeric runId assigned by pm");
    }
    if (activeRuns.has(runId)) {
      throw new Error(`run ${runId} is already active`);
    }
    const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : defaultRunTimeoutMs();

    await logManager.ensureLogDir();
    const repoDir = await resolveRepoDir();
    const pmDir = pmDirFor(repoDir);
    const task = await findTask(pmDir, taskId);
    if (!task) {
      throw new Error(`task ${taskId} not found`);
    }

    const branchName = `pm/task-${task.id}-${task.slug}`;
    const workspaceDir = join(os.homedir(), "work", `task-${task.id}-${task.slug}`);

    if (phase === "verify" || phase === "review") {
      const job = new RunJob();
      activeRuns.set(runId, {
        runId,
        containerName: `pm-agent-run-${runId}`,
        kill: () => job.cancel(),
      });

      if (phase === "verify") {
        void executeVerify({
          runId,
          taskId,
          projectName: ctx.project,
          repoDir,
          task,
          branchName,
          job,
          timeoutMs,
        });
      } else {
        void executeReview({
          runId,
          taskId,
          projectName: ctx.project,
          repoDir,
          branchName,
          provider,
          model,
          prompt,
          job,
          timeoutMs,
        });
      }
      return { runId, status: "running" };
    }

    await prepareWorktree({ repoDir, workspaceDir, branchName, runId });

    // The branch exists now, so the task's front matter can name it (this is
    // what makes the branch chip render in the task header).
    if (task.branch !== branchName) {
      try {
        await setTaskBranch(task as TaskRecord, branchName);
      } catch (err) {
        console.error(`run ${runId} could not record branch on task ${task.id}:`, err);
      }
    }

    const containerName = `pm-agent-run-${runId}`;
    activeRuns.set(runId, {
      runId,
      containerName,
      kill: () => stopContainer(containerName),
    });

    const timer = setTimeout(() => {
      console.warn(`run ${runId} timed out after ${timeoutMs}ms, stopping container`);
      void stopContainer(containerName);
    }, timeoutMs);

    // The container runs in the background; startRun answers immediately and
    // pm follows the run through streamLogs.
    void spawnAgentContainer({
      runId,
      containerName,
      workspaceDir,
      provider,
      model,
      prompt,
    }).then(async (code) => {
      clearTimeout(timer);
      activeRuns.delete(runId);
      console.log(`run ${runId} container exited with code ${code}`);
      if (phase !== "implement") {
        await stashStrayChanges(workspaceDir, runId, phase);
      }
      await logManager.endRun(runId, code);
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
    const { branch, message } = args;
    const repoDir = await resolveRepoDir();

    if (!branch) {
      // Default branch: only pm's own metadata is ever committed here.
      try {
        await runGit(["add", ".pm/"], repoDir);
        const staged = await runGit(["status", "--porcelain", "--", ".pm/"], repoDir);
        if (!staged) {
          return { branch: "", pushed: true, committed: false };
        }
        await runGit(["commit", "-m", message || "pm: update metadata"], repoDir);
        await runGit(["push", "origin", "HEAD"], repoDir);
        return { branch: "", pushed: true, committed: true };
      } catch (err) {
        console.error("commitAndPush default branch error:", err);
        return { branch: "", pushed: false, committed: false, error: errMessage(err) };
      }
    }

    const match = branch.match(/^pm\/task-(\d+)-(.+)$/);
    if (!match) {
      throw new Error(`invalid task branch name: ${branch}`);
    }
    const taskId = parseInt(match[1], 10);
    const slug = match[2];
    const workspaceDir = join(os.homedir(), "work", `task-${taskId}-${slug}`);

    let committed = false;
    try {
      // Belt and braces: the implement prompt tells the agent to commit, but
      // an agent that forgot must not have its work pushed away into nothing —
      // or reset away by the next run.
      if (await isDirty(workspaceDir)) {
        await runGit(["add", "-A"], workspaceDir);
        await runGit(["commit", "-m", message || `pm: implement task ${taskId}`], workspaceDir);
        committed = true;
      }
      // Nothing to commit is not an error: pushing an unchanged branch is a
      // no-op, and the branch may simply already be up to date on the remote.
      await runGit(["push", "origin", branch], workspaceDir);
      return { branch, pushed: true, committed };
    } catch (err) {
      // A rejected push (the remote moved on) leaves the work committed
      // locally in the worktree; pm surfaces the error and the next run picks
      // the branch back up.
      console.error(`commitAndPush branch ${branch} error:`, err);
      return { branch, pushed: false, committed, error: errMessage(err) };
    }
  },

  diff: async (args) => {
    const { branch } = args;
    const repoDir = await resolveRepoDir();
    const base = args.base || (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir));

    try {
      await runGit(["rev-parse", "--verify", branch], repoDir);
    } catch {
      return { branch, base, diff: "", found: false };
    }

    const diff = await runGit(["diff", `${base}...${branch}`], repoDir);
    return { branch, base, diff, found: true };
  },

  sweepVerifyEnvs: async () => {
    // Compose projects left behind by a verify/review that died before its
    // teardown ran. Their compose files are gone with the temporary checkout,
    // so this works off compose's own labels rather than `compose down`.
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--format",
      '{{.Label "com.docker.compose.project"}}',
    ]);
    const projects = new Set(
      String(stdout)
        .split("\n")
        .map((n) => n.trim())
        .filter((n) => n.startsWith(EPHEMERAL_COMPOSE_PREFIX)),
    );

    const removed: string[] = [];
    for (const project of projects) {
      if (activeRuns.size > 0 && [...activeRuns.keys()].some((id) => project.endsWith(`-${id}`))) {
        continue;
      }
      const label = `label=com.docker.compose.project=${project}`;
      try {
        for (const [kind, extra] of [
          ["container", ["rm", "-f"]],
          ["volume", ["rm", "-f"]],
          ["network", ["rm"]],
        ] as const) {
          const listArgs =
            kind === "container"
              ? ["ps", "-aq", "--filter", label]
              : [kind, "ls", "-q", "--filter", label];
          const listed = await execFileAsync("docker", listArgs);
          const ids = String(listed.stdout)
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          if (ids.length > 0) {
            await execFileAsync("docker", [...(kind === "container" ? [] : [kind]), ...extra, ...ids]);
          }
        }
        removed.push(project);
      } catch (err) {
        console.error(`sweepVerifyEnvs: could not remove ${project}:`, errMessage(err));
      }
    }
    return { removed };
  },
};
