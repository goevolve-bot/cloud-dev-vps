import { createConnection } from "node:net";

/**
 * Client for the `pm-projectctl` daemon: one NDJSON request per connection,
 * answered by zero or more `progress` events and exactly one terminal
 * `result` / `error` event (see the protocol comment at the top of
 * app/scripts/pm-projectctl).
 */

export interface ProjectctlResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  /** Verb-specific; every verb's shape is documented in pm-projectctl. */
  readonly data?: Record<string, unknown>;
}

export interface ProjectctlProgress {
  readonly step: string;
  readonly message: string;
}

/**
 * Read at call time, not at module load: the tests point this at a stub
 * daemon on a temp path, and a module-level constant would freeze the real
 * path before they get the chance.
 */
export function projectctlSocketPath(): string {
  return process.env.PM_PROJECTCTL_SOCK ?? "/srv/pm/projectctl.sock";
}

/**
 * `create` runs for minutes and reports its stage as it goes; pass
 * `onProgress` to forward those stages somewhere (the SSE stream behind
 * POST /api/projects). Never rejects — every failure comes back as
 * `{ ok: false, code, message }` so callers have one shape to handle.
 */
export function callProjectctl(
  verb: string,
  args: Record<string, unknown>,
  onProgress?: (progress: ProjectctlProgress) => void,
): Promise<ProjectctlResult> {
  return new Promise((resolve) => {
    const socket = createConnection(projectctlSocketPath());
    socket.setEncoding("utf8");

    let settled = false;
    const settle = (result: ProjectctlResult) => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(result);
    };

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
        let msg: { type?: string; step?: string; message?: string };
        try {
          msg = JSON.parse(line);
        } catch (err) {
          settle({ ok: false, code: "parse_error", message: String(err) });
          return;
        }
        if (msg.type === "progress") {
          onProgress?.({ step: msg.step ?? "", message: msg.message ?? "" });
          continue;
        }
        if (msg.type === "result" || msg.type === "error") {
          settle(msg as ProjectctlResult);
          return;
        }
      }
    });

    socket.on("error", (err) => {
      settle({ ok: false, code: "connection_error", message: err.message });
    });

    // The daemon closing without a terminal event (a crashed worker, a
    // restarted socket unit) would otherwise leave this promise pending
    // forever, and with it the request that is awaiting it.
    socket.on("close", () => {
      settle({ ok: false, code: "connection_closed", message: "projectctl closed the connection" });
    });
  });
}
