import { buildApp, reconcileDiscoveredProjects } from "./app.js";
import { openDb } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { RunnerRegistry } from "./runners/registry.js";

// Defaults mirror the bind mounts in compose.yaml: everything the server must
// keep across a container recreate lives under /srv/pm/data on the host, and
// nothing defaults to a path that only exists inside the image.
const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.PM_DB_PATH ?? "/srv/pm/data/pm.sqlite3";
const runnersDir = process.env.PM_RUNNERS_DIR ?? "/srv/pm/runners";

const db = openDb(dbPath);
migrateUp(db);

const runners = new RunnerRegistry({ runnersDir });
await runners.start();

// Best effort: a projectctl socket that is not there yet must not stop the
// API from coming up.
try {
  const adopted = await reconcileDiscoveredProjects({ db, runners });
  if (adopted.length > 0) console.log(`adopted out-of-band projects: ${adopted.join(", ")}`);
} catch (err) {
  console.warn("reconciling discovered projects failed:", err);
}

const app = buildApp({ db, runners });

try {
  const address = await app.listen({ port, host: "0.0.0.0" });
  console.log(`pm server listening on ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
