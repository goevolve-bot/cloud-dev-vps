import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { RunnerMessage } from "@pm/core";

export interface FakeRunnerServer {
  readonly server: Server;
  /** Destroys any open connections, then closes the server and calls back —
   * plain server.close() alone would wait forever for a still-open client
   * connection to end on its own. */
  shutdown(): Promise<void>;
}

/** A minimal stand-in for @pm/runner's socket server, just enough to exercise
 * RunnerClient/RunnerRegistry without a cross-package test dependency. */
export function startFakeRunnerServer(socketPath: string): FakeRunnerServer {
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
        const request = JSON.parse(line) as { id: string; verb: string };
        const message: RunnerMessage = {
          type: "result",
          id: request.id,
          ok: true,
          data: { project: "demo", pid: process.pid, uptimeMs: 0, activeRunIds: [] } as never,
        };
        socket.write(`${JSON.stringify(message)}\n`);
      }
    });
  });
  if (existsSync(socketPath)) unlinkSync(socketPath);
  server.listen(socketPath);
  return {
    server,
    shutdown: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
