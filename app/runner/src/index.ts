import { createRunnerServer } from "./socket-server.js";
import { handlers } from "./handlers.js";

const project = process.env.PM_PROJECT;
const socketPath = process.env.PM_RUNNER_SOCKET;

if (!project || !socketPath) {
  console.error("pm runner: PM_PROJECT and PM_RUNNER_SOCKET must both be set");
  process.exit(1);
}

if (!process.env.PM_REPO_DIR) {
  console.warn(
    "pm runner: PM_REPO_DIR is not set; falling back to ~/work, which only works with a single checkout",
  );
}

const server = createRunnerServer({ project, socketPath });
console.log(`pm runner for ${project} listening on ${socketPath}`);

// A runner that was killed mid-verify leaves its throwaway compose stack
// behind. Nothing else will ever clean those up, so do it at boot.
void handlers
  .sweepVerifyEnvs({}, { project, startedAt: Date.now(), emit: () => {} })
  .then(({ removed }) => {
    if (removed.length > 0) {
      console.log(`pm runner: removed leftover verification environments: ${removed.join(", ")}`);
    }
  })
  .catch((err) => console.error("pm runner: verification environment sweep failed:", err));

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
