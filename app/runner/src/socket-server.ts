import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { RunnerEvent, RunnerMessage, RunnerRequest, RunnerVerb } from "@pm/core";
import { handlers, type HandlerContext } from "./handlers.js";

export interface RunnerServerOptions {
  readonly socketPath: string;
  readonly project: string;
}

function isRunnerVerb(value: string): value is RunnerVerb {
  return value in handlers;
}

function writeMessage(socket: Socket, message: RunnerMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function parseRequest(line: string): RunnerRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { id, verb, args } = parsed as Record<string, unknown>;
  if (typeof id !== "string" || typeof verb !== "string" || !isRunnerVerb(verb)) return null;
  return { id, verb, args: (args ?? {}) as never };
}

async function handleRequest(
  socket: Socket,
  project: string,
  startedAt: number,
  request: RunnerRequest,
): Promise<void> {
  const ctx: HandlerContext = {
    project,
    startedAt,
    emit: (event: RunnerEvent) => writeMessage(socket, { type: "event", id: request.id, event }),
  };
  try {
    // The verb registry maps each verb to its own arg/result types; once
    // dispatched through a runtime-narrowed key, TS can no longer correlate
    // request.args with the specific handler it lines up with at runtime.
    const handler = handlers[request.verb] as (
      args: never,
      ctx: HandlerContext,
    ) => Promise<unknown>;
    const data = await handler(request.args as never, ctx);
    writeMessage(socket, { type: "result", id: request.id, ok: true, data: data as never });
  } catch (err) {
    const code =
      err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "internal";
    const message = err instanceof Error ? err.message : String(err);
    writeMessage(socket, { type: "error", id: request.id, ok: false, code, message });
  }
}

function handleConnection(socket: Socket, project: string, startedAt: number): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineAt = buffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      newlineAt = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const request = parseRequest(line);
      if (!request) {
        writeMessage(socket, {
          type: "error",
          id: "",
          ok: false,
          code: "bad_request",
          message: "invalid request: expected {id, verb, args}",
        });
        continue;
      }
      void handleRequest(socket, project, startedAt, request);
    }
  });
}

export function createRunnerServer(opts: RunnerServerOptions): Server {
  const startedAt = Date.now();
  const server = createServer((socket) => handleConnection(socket, opts.project, startedAt));

  if (existsSync(opts.socketPath)) {
    unlinkSync(opts.socketPath);
  }
  server.listen(opts.socketPath);
  return server;
}
