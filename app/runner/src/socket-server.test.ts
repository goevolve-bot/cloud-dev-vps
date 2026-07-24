import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { RunnerMessage } from "@pm/core";
import { createRunnerServer } from "./socket-server.js";
import { childProcess } from "./exec.js";
import { EventEmitter } from "node:events";

let tempDir: string;
let socketPath: string;
let server: any;

const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
const originalHomedir = os.homedir;

const execCalls: { file: string; args: string[]; cwd?: string }[] = [];
const spawnCalls: { file: string; args: string[] }[] = [];

before(async () => {
  tempDir = await mkdtemp(join(os.tmpdir(), "pm-runner-test-"));
  socketPath = join(tempDir, "control.sock");

  // Mock os.homedir
  os.homedir = () => tempDir;

  // Mock childProcess.execFile
  childProcess.execFile = ((file: string, args: string[], opts: any, callback: any) => {
    const cb = typeof opts === "function" ? opts : callback;
    const cwd = typeof opts === "object" ? opts.cwd : undefined;
    execCalls.push({ file, args, cwd });

    if (file === "git") {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        cb(null, { stdout: "main\n", stderr: "" });
        return;
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        cb(null, { stdout: "hash\n", stderr: "" });
        return;
      }
      if (args[0] === "status") {
        cb(null, { stdout: " M .pm/tasks/todo/0001-demo/index.md\n", stderr: "" });
        return;
      }
    }
    cb(null, { stdout: "", stderr: "" });
  }) as any;

  // Mock childProcess.spawn
  childProcess.spawn = ((file: string, args: string[]) => {
    spawnCalls.push({ file, args });
    const stdout = new EventEmitter() as any;
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter() as any;
    stderr.setEncoding = () => {};
    const child = new EventEmitter() as any;
    child.stdout = stdout;
    child.stderr = stderr;
    child.pid = 99999;

    process.nextTick(() => {
      stdout.emit("data", '{"type":"assistant","message":"thinking"}\n');
      stdout.emit("data", '{"type":"result","result":"done","total_cost_usd":0.05,"usage":{"input_tokens":100,"output_tokens":50}}\n');
      child.emit("close", 0);
    });

    return child;
  }) as any;

  // Prepare fake directory structure
  await mkdir(join(tempDir, "work", "demo-repo", ".pm", "tasks", "todo", "0001-demo"), { recursive: true });
  await writeFile(
    join(tempDir, "work", "demo-repo", ".pm", "tasks", "todo", "0001-demo", "index.md"),
    "---\nid: 1\ntitle: demo\ncreated: 2026-01-01T00:00:00Z\nbranch: null\n---\nDemo task",
    "utf8"
  );
  await mkdir(join(tempDir, ".pm-creds"), { recursive: true });
  await writeFile(join(tempDir, ".pm-creds", "claude"), "fake-key", "utf8");

  server = createRunnerServer({ socketPath, project: "demo" });
});

after(async () => {
  os.homedir = originalHomedir;
  childProcess.execFile = originalExecFile;
  childProcess.spawn = originalSpawn;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

test("status reports the project, pid, and active runs", async () => {
  const messages = await call({ id: "1", verb: "status", args: {} });
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.type, "result");
  assert.ok(message.type === "result" && message.ok);
  if (message.type === "result") {
    const data = message.data as unknown as { project: string; activeRunIds: number[] };
    assert.equal(data.project, "demo");
    assert.deepEqual(data.activeRunIds, []);
  }
});

test("startRun, streamLogs, stopRun, and commitAndPush work end-to-end", async () => {
  // 1. Call startRun
  const startMsgs = await call({
    id: "2",
    verb: "startRun",
    args: {
      taskId: 1,
      phase: "implement",
      provider: "claude",
      model: "claude-3-5-sonnet-latest",
      prompt: "do work",
    },
  });
  assert.equal(startMsgs.length, 1);
  const [startMsg] = startMsgs;
  if (startMsg.type === "error") {
    console.error("DEBUG startMsg:", startMsg);
  }
  assert.equal(startMsg.type, "result");
  assert.ok(startMsg.type === "result" && startMsg.ok);
  const runId = (startMsg.data as any).runId;
  assert.ok(typeof runId === "number");

  // 2. Stream logs
  const logMsgs = await call({
    id: "3",
    verb: "streamLogs",
    args: { runId },
  });
  assert.ok(logMsgs.length >= 2);
  const last = logMsgs[logMsgs.length - 1];
  assert.equal(last.type, "result");
  assert.ok(
    last.type === "result" &&
      last.data &&
      (last.data as any).complete,
  );

  // 3. Stop run
  const stopMsgs = await call({
    id: "4",
    verb: "stopRun",
    args: { runId },
  });
  assert.equal(stopMsgs.length, 1);
  assert.equal(stopMsgs[0].type, "result");
  assert.ok(stopMsgs[0].type === "result" && stopMsgs[0].ok);
  assert.equal((stopMsgs[0].data as any).stopped, false);

  // 4. Commit and push metadata
  const capMsgs = await call({
    id: "5",
    verb: "commitAndPush",
    args: { branch: "" },
  });
  assert.equal(capMsgs.length, 1);
  assert.equal(capMsgs[0].type, "result");
  assert.ok(capMsgs[0].type === "result" && capMsgs[0].ok);
  assert.equal((capMsgs[0].data as any).pushed, true);
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
