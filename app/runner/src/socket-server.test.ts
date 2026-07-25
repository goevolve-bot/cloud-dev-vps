import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { RunnerMessage } from "@pm/core";
import { createRunnerServer } from "./socket-server.js";
import { childProcess } from "./exec.js";
import { EventEmitter } from "node:events";
import type { ChildProcess, ExecFileOptions } from "node:child_process";

let tempDir: string;
let repoDir: string;
let socketPath: string;
let server: ReturnType<typeof createRunnerServer> | undefined;

const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
const originalHomedir = os.homedir;
const originalRepoDirEnv = process.env.PM_REPO_DIR;

let execCalls: { file: string; args: string[]; cwd?: string }[] = [];
let spawnCalls: { file: string; args: string[] }[] = [];

/** Working trees the mocked `git status --porcelain` reports as dirty. */
let dirtyDirs = new Set<string>();
/** Refs the mocked `git rev-parse --verify` knows about. */
let knownRefs = new Set<string>();
let pushFails = false;
/** Exit code the mocked agent container closes with. */
let containerExitCode = 0;

function gitReply(args: string[], cwd: string | undefined): string | Error {
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
  if (args[0] === "rev-parse" && args[1] === "--verify") {
    return knownRefs.has(args[2]) ? "hash\n" : new Error(`fatal: unknown revision ${args[2]}`);
  }
  if (args[0] === "status") {
    if (args.includes(".pm/")) return " M .pm/tasks/todo/0001-demo/index.md\n";
    return cwd && dirtyDirs.has(cwd) ? " M src/index.ts\n" : "";
  }
  if (args[0] === "remote") return "git@example.com:demo/demo.git\n";
  if (args[0] === "diff") return "diff --git a/src/index.ts b/src/index.ts\n+added\n";
  if (args[0] === "push" && pushFails) {
    return new Error("! [rejected] pm/task-1-demo -> pm/task-1-demo (fetch first)");
  }
  return "";
}

before(async () => {
  tempDir = await mkdtemp(join(os.tmpdir(), "pm-runner-test-"));
  socketPath = join(tempDir, "control.sock");
  repoDir = join(tempDir, "work", "demo-repo");

  os.homedir = () => tempDir;
  process.env.PM_REPO_DIR = repoDir;

  type ExecFileCallback = (
    error: Error | null,
    result?: { stdout: string; stderr: string },
  ) => void;

  childProcess.execFile = ((
    file: string,
    args: string[],
    opts: ExecFileOptions | ExecFileCallback,
    callback?: ExecFileCallback,
  ) => {
    const cb = typeof opts === "function" ? opts : callback;
    const cwd = typeof opts === "object" && opts && typeof opts.cwd === "string" ? opts.cwd : undefined;
    execCalls.push({ file, args, cwd });

    const reply = file === "git" ? gitReply(args, cwd) : "";
    if (reply instanceof Error) {
      cb?.(reply);
      return;
    }
    cb?.(null, { stdout: reply, stderr: "" });
  }) as unknown as typeof childProcess.execFile;

  /** A bare EventEmitter with just enough of the Readable surface the runner touches. */
  function fakeReadable(): EventEmitter & { setEncoding: (enc: string) => void } {
    const emitter = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
    emitter.setEncoding = () => {};
    return emitter;
  }

  childProcess.spawn = ((file: string, args: string[]) => {
    spawnCalls.push({ file, args });
    const stdout = fakeReadable();
    const stderr = fakeReadable();
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdout, stderr, pid: 99999, kill: () => true });

    process.nextTick(() => {
      stdout.emit("data", '{"type":"assistant","message":"thinking"}\n');
      stdout.emit(
        "data",
        '{"type":"result","result":"done","total_cost_usd":0.05,"usage":{"input_tokens":100,"output_tokens":50}}\n',
      );
      child.emit("close", containerExitCode);
    });

    return child;
  }) as unknown as typeof childProcess.spawn;

  for (const [num, slug] of [
    [1, "demo"],
    [2, "second"],
    [3, "third"],
  ] as const) {
    const dir = join(repoDir, ".pm", "tasks", "todo", `${String(num).padStart(4, "0")}-${slug}`);
    await mkdir(join(dir, "runs"), { recursive: true });
    await writeFile(
      join(dir, "index.md"),
      `---\nid: ${num}\ntitle: ${slug}\ncreated: 2026-01-01T00:00:00Z\nbranch: null\n---\nDemo task`,
      "utf8",
    );
  }
  await mkdir(join(tempDir, ".pm-creds"), { recursive: true });
  await writeFile(join(tempDir, ".pm-creds", "anthropic"), "fake-key", "utf8");

  server = createRunnerServer({ socketPath, project: "demo" });
});

beforeEach(() => {
  execCalls = [];
  spawnCalls = [];
  dirtyDirs = new Set();
  knownRefs = new Set();
  pushFails = false;
  containerExitCode = 0;
});

after(async () => {
  os.homedir = originalHomedir;
  childProcess.execFile = originalExecFile;
  childProcess.spawn = originalSpawn;
  if (originalRepoDirEnv === undefined) delete process.env.PM_REPO_DIR;
  else process.env.PM_REPO_DIR = originalRepoDirEnv;
  if (server) {
    const s = server;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await rm(tempDir, { recursive: true, force: true });
});

/** Sends one request and collects every message until the terminal result/error for its id. */
async function call(
  request: { id: string; verb: string; args?: unknown },
): Promise<RunnerMessage[]> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    const messages: RunnerMessage[] = [];
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as RunnerMessage;
        messages.push(message);
        if (message.type === "result" || message.type === "error") {
          socket.end();
          resolve(messages);
          return;
        }
      }
    });
    socket.on("error", reject);
  });
}

function resultData(messages: RunnerMessage[]): Record<string, unknown> {
  const last = messages[messages.length - 1];
  assert.equal(last.type, "result", `expected a result, got ${JSON.stringify(last)}`);
  if (last.type !== "result") throw new Error("unreachable — asserted above");
  return last.data as unknown as Record<string, unknown>;
}

function startRun(args: Record<string, unknown>): Promise<RunnerMessage[]> {
  return call({
    id: `start-${args.runId}`,
    verb: "startRun",
    args: { phase: "implement", provider: "claude", model: "claude-3-5-sonnet-latest", prompt: "do work", ...args },
  });
}

test("status reports the project, pid, and active runs", async () => {
  const messages = await call({ id: "1", verb: "status", args: {} });
  assert.equal(messages.length, 1);
  const data = resultData(messages);
  assert.equal(data.project, "demo");
  assert.deepEqual(data.activeRunIds, []);
});

test("startRun, streamLogs, stopRun, and commitAndPush work end-to-end", async () => {
  const startMsgs = await startRun({ runId: 41, taskId: 1 });
  assert.equal(resultData(startMsgs).runId, 41);

  const logMsgs = await call({ id: "3", verb: "streamLogs", args: { runId: 41 } });
  assert.ok(logMsgs.length >= 3);
  const streamResult = resultData(logMsgs);
  assert.equal(streamResult.complete, true);
  // The container's real exit code reaches pm instead of being inferred.
  assert.equal(streamResult.exitCode, 0);

  const stopMsgs = await call({ id: "4", verb: "stopRun", args: { runId: 41 } });
  assert.equal(resultData(stopMsgs).stopped, false);

  const capMsgs = await call({ id: "5", verb: "commitAndPush", args: { branch: "" } });
  assert.equal(resultData(capMsgs).pushed, true);
});

test("pm assigns the run id, and the runner uses it for the log file and container name", async () => {
  await startRun({ runId: 77, taskId: 1 });
  await call({ id: "wait-77", verb: "streamLogs", args: { runId: 77 } });

  const log = await readFile(join(tempDir, "logs", "77.log"), "utf8");
  assert.match(log, /thinking/);

  const dockerRun = spawnCalls.find((c) => c.file === "docker" && c.args[0] === "run");
  assert.ok(dockerRun);
  assert.equal(dockerRun.args[dockerRun.args.indexOf("--name") + 1], "pm-agent-run-77");
});

test("the credential shim picks the env var Claude Code actually reads", async () => {
  await startRun({ runId: 78, taskId: 1 });
  await call({ id: "wait-78", verb: "streamLogs", args: { runId: 78 } });

  const dockerRun = spawnCalls.find((c) => c.file === "docker" && c.args[0] === "run");
  assert.ok(dockerRun);
  const shim = dockerRun.args[dockerRun.args.indexOf("-c") + 1];

  // An OAuth token (`claude setup-token`) authenticates only through
  // CLAUDE_CODE_OAUTH_TOKEN; exported as ANTHROPIC_API_KEY it 401s on every
  // call. A console key is the other way round. One credential slot, so the
  // shim has to branch on the value at container start.
  assert.match(shim, /sk-ant-oat\*\) CLAUDE_CODE_OAUTH_TOKEN=/);
  assert.match(shim, /\*\) ANTHROPIC_API_KEY=/);
  // The value is only ever read inside the container, never placed on argv.
  assert.ok(!shim.includes("sk-ant-api"));
});

test("startRun rejects a request without a pm-assigned run id", async () => {
  const messages = await call({
    id: "no-run-id",
    verb: "startRun",
    args: { taskId: 1, phase: "implement", provider: "claude", model: "m", prompt: "p" },
  });
  assert.equal(messages[0].type, "error");
  assert.ok(messages[0].type === "error" && /runId/.test(messages[0].message));
});

test("concurrent runs on different tasks get distinct log files and container names", async () => {
  await Promise.all([startRun({ runId: 101, taskId: 1 }), startRun({ runId: 102, taskId: 2 })]);
  await Promise.all([
    call({ id: "w101", verb: "streamLogs", args: { runId: 101 } }),
    call({ id: "w102", verb: "streamLogs", args: { runId: 102 } }),
  ]);

  const first = await readFile(join(tempDir, "logs", "101.log"), "utf8");
  const second = await readFile(join(tempDir, "logs", "102.log"), "utf8");
  // Each log holds exactly its own run's two lines — no interleaving.
  assert.equal(first.split("\n").filter(Boolean).length, 2);
  assert.equal(second.split("\n").filter(Boolean).length, 2);

  const names = spawnCalls
    .filter((c) => c.file === "docker")
    .map((c) => c.args[c.args.indexOf("--name") + 1])
    .sort();
  assert.deepEqual(names, ["pm-agent-run-101", "pm-agent-run-102"]);
});

test("startRun leaves the task's front matter alone — pm owns .pm/", async () => {
  // This used to assert the opposite, and passed, because a unit test writes
  // into a temp dir it owns. On a real host `.pm/` is created by the pm server
  // and lands `pm:pm 0644`, while the runner is the project user, which is
  // deliberately never in the `pm` group — so the write failed with EACCES on
  // every implement run and the task's branch stayed null. Recording it is
  // pm's job now (see queue.ts); the runner must not try.
  await startRun({ runId: 55, taskId: 3 });
  await call({ id: "w55", verb: "streamLogs", args: { runId: 55 } });

  const index = await readFile(
    join(repoDir, ".pm", "tasks", "todo", "0003-third", "index.md"),
    "utf8",
  );
  assert.match(index, /branch: null/);
});

test("startRun commits a dirty worktree instead of resetting it away", async () => {
  const workspaceDir = join(tempDir, "work", "task-1-demo");
  await mkdir(workspaceDir, { recursive: true });
  dirtyDirs.add(workspaceDir);

  await startRun({ runId: 88, taskId: 1 });
  await call({ id: "w88", verb: "streamLogs", args: { runId: 88 } });

  const inWorktree = execCalls.filter((c) => c.file === "git" && c.cwd === workspaceDir);
  assert.ok(
    inWorktree.some((c) => c.args[0] === "add" && c.args[1] === "-A"),
    "expected the residual changes to be staged",
  );
  assert.ok(inWorktree.some((c) => c.args[0] === "commit"));
  assert.ok(
    !inWorktree.some((c) => c.args[0] === "reset"),
    "the worktree must never be reset while it holds uncommitted work",
  );

  await rm(workspaceDir, { recursive: true, force: true });
});

test("commitAndPush stages and commits residual work before pushing the branch", async () => {
  const workspaceDir = join(tempDir, "work", "task-1-demo");
  dirtyDirs.add(workspaceDir);

  const messages = await call({
    id: "cap-dirty",
    verb: "commitAndPush",
    args: { branch: "pm/task-1-demo", message: "pm: implement task 1" },
  });
  const data = resultData(messages);
  assert.deepEqual({ branch: data.branch, pushed: data.pushed, committed: data.committed }, {
    branch: "pm/task-1-demo",
    pushed: true,
    committed: true,
  });

  const gitArgs = execCalls.filter((c) => c.cwd === workspaceDir).map((c) => c.args.join(" "));
  assert.ok(gitArgs.includes("add -A"));
  assert.ok(gitArgs.includes("commit -m pm: implement task 1"));
  assert.ok(gitArgs.includes("push origin pm/task-1-demo"));
});

test("commitAndPush with nothing to commit still pushes", async () => {
  const messages = await call({
    id: "cap-clean",
    verb: "commitAndPush",
    args: { branch: "pm/task-1-demo" },
  });
  const data = resultData(messages);
  assert.equal(data.committed, false);
  assert.equal(data.pushed, true);
  assert.ok(
    !execCalls.some((c) => c.args[0] === "commit"),
    "a clean worktree must not produce an empty commit",
  );
});

test("commitAndPush reports a rejected push instead of claiming success", async () => {
  const workspaceDir = join(tempDir, "work", "task-1-demo");
  dirtyDirs.add(workspaceDir);
  pushFails = true;

  const data = resultData(
    await call({ id: "cap-reject", verb: "commitAndPush", args: { branch: "pm/task-1-demo" } }),
  );
  assert.equal(data.pushed, false);
  // The work is committed locally, so the next run picks the branch back up.
  assert.equal(data.committed, true);
  assert.match(data.error as string, /rejected/);
});

test("diff is computed by the runner, against the repo's default branch", async () => {
  knownRefs.add("pm/task-1-demo");
  const data = resultData(await call({ id: "diff-1", verb: "diff", args: { branch: "pm/task-1-demo" } }));
  assert.equal(data.found, true);
  assert.equal(data.base, "main");
  assert.match(data.diff as string, /^diff --git/);

  const diffCall = execCalls.find((c) => c.args[0] === "diff");
  assert.deepEqual(diffCall?.args, ["diff", "main...pm/task-1-demo"]);
  assert.equal(diffCall?.cwd, repoDir);
});

test("diff reports a missing branch rather than failing the run", async () => {
  const data = resultData(await call({ id: "diff-2", verb: "diff", args: { branch: "pm/task-9-nope" } }));
  assert.equal(data.found, false);
  assert.equal(data.diff, "");
});

test("the repo directory comes from PM_REPO_DIR, not from guessing at ~/work", async () => {
  // A verify checkout is a sibling of the repo; the old scan could return it.
  await mkdir(join(tempDir, "work", "verify-1-9"), { recursive: true });
  delete process.env.PM_REPO_DIR;
  try {
    const data = resultData(await call({ id: "diff-3", verb: "diff", args: { branch: "x" } }));
    // The fallback skips ephemeral directories and still finds the one repo.
    assert.equal(data.base, "main");
    assert.equal(execCalls.find((c) => c.args[0] === "rev-parse")?.cwd, repoDir);

    execCalls = [];
    process.env.PM_REPO_DIR = join(tempDir, "work", "demo-repo");
    await call({ id: "diff-4", verb: "diff", args: { branch: "x" } });
    assert.equal(execCalls.find((c) => c.args[0] === "rev-parse")?.cwd, repoDir);
  } finally {
    process.env.PM_REPO_DIR = repoDir;
    await rm(join(tempDir, "work", "verify-1-9"), { recursive: true, force: true });
  }
});

test("an unknown verb is rejected without touching any handler", async () => {
  const messages = await call({ id: "6", verb: "nope", args: {} });
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.type, "error");
  assert.ok(message.type === "error" && message.code === "bad_request");
});

test("multiple requests over one connection are answered independently", async () => {
  const socket = createConnection(socketPath);
  const messages: RunnerMessage[] = [];
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  socket.write(`${JSON.stringify({ id: "a", verb: "status", args: {} })}\n`);
  socket.write(`${JSON.stringify({ id: "b", verb: "status", args: {} })}\n`);
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
        if (line.trim()) messages.push(JSON.parse(line) as RunnerMessage);
      }
      if (messages.length >= 2) resolve();
    });
    socket.on("error", reject);
  });
  socket.end();
  assert.deepEqual(messages.map((m) => m.id).sort(), ["a", "b"]);
});
