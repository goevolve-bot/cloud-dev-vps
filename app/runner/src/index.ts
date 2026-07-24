import { createRunnerServer } from "./socket-server.js";

const project = process.env.PM_PROJECT;
const socketPath = process.env.PM_RUNNER_SOCKET;

if (!project || !socketPath) {
  console.error("pm runner: PM_PROJECT and PM_RUNNER_SOCKET must both be set");
  process.exit(1);
}

const server = createRunnerServer({ project, socketPath });
console.log(`pm runner for ${project} listening on ${socketPath}`);

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
