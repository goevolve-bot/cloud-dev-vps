import { buildApp } from "./app.js";
import { openDb } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { RunnerRegistry } from "./runners/registry.js";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.PM_DB_PATH ?? "/var/lib/pm/pm.sqlite3";
const runnersDir = process.env.PM_RUNNERS_DIR ?? "/srv/pm/runners";

const db = openDb(dbPath);
migrateUp(db);

const runners = new RunnerRegistry({ runnersDir });
await runners.start();

const app = buildApp({ db, runners });

try {
  const address = await app.listen({ port, host: "0.0.0.0" });
  console.log(`pm server listening on ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
