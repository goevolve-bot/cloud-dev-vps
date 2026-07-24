import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerMessage } from "@pm/core";
import { createRunnerServer } from "./socket-server.js";

async function withServer(fn: (socketPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pm-runner-test-"));
  const socketPath = join(dir, "control.sock");
  const server = createRunnerServer({ socketPath, project: "demo" });
  try {
    await fn(socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

/** Sends one request and collects every message until the terminal result/error for its id. */
async function call(
  socketPath: string,
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

test("status reports the project, pid, and no active runs", () =>
  withServer(async (socketPath) => {
    const messages = await call(socketPath, { id: "1", verb: "status", args: {} });
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(message.type, "result");
    assert.ok(message.type === "result" && message.ok);
    if (message.type === "result") {
      const data = message.data as unknown as { project: string; activeRunIds: number[] };
      assert.equal(data.project, "demo");
      assert.deepEqual(data.activeRunIds, []);
    }
  }));

test("streamLogs emits dummy log events before a complete result", () =>
  withServer(async (socketPath) => {
    const messages = await call(socketPath, { id: "2", verb: "streamLogs", args: { runId: 7 } });
    assert.equal(messages.length, 4);
    for (const message of messages.slice(0, 3)) {
      assert.equal(message.type, "event");
      assert.equal(message.id, "2");
    }
    const last = messages[messages.length - 1];
    assert.equal(last.type, "result");
    assert.ok(
      last.type === "result" &&
        last.data &&
        (last.data as unknown as { complete: boolean }).complete,
    );
  }));

test("startRun, stopRun, and commitAndPush are stubbed as not_implemented", () =>
  withServer(async (socketPath) => {
    for (const [verb, args] of [
      [
        "startRun",
        {
          taskId: 1,
          phase: "implement",
          provider: "claude",
          model: "claude-sonnet-5",
          prompt: "x",
        },
      ],
      ["stopRun", { runId: 1 }],
      ["commitAndPush", { branch: "pm/task-1-x" }],
    ] as const) {
      const messages = await call(socketPath, { id: "3", verb, args });
      assert.equal(messages.length, 1);
      const [message] = messages;
      assert.equal(message.type, "error");
      assert.ok(message.type === "error" && message.code === "not_implemented", verb);
    }
  }));

test("an unknown verb is rejected without touching any handler", () =>
  withServer(async (socketPath) => {
    const messages = await call(socketPath, { id: "4", verb: "nope", args: {} });
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(message.type, "error");
    assert.ok(message.type === "error" && message.code === "bad_request");
  }));

test("multiple requests over one connection are answered independently", () =>
  withServer(async (socketPath) => {
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
  }));
