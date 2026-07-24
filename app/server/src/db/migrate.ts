import type Database from "better-sqlite3";
import { migrations } from "./migrations/index.js";

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `);
}

function appliedVersions(db: Database.Database): Set<number> {
  ensureMigrationsTable(db);
  const rows = db.prepare("SELECT version FROM _migrations").all() as { version: number }[];
  return new Set(rows.map((row) => row.version));
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly applied: boolean;
}

export function migrationStatus(db: Database.Database): MigrationRecord[] {
  const applied = appliedVersions(db);
  return migrations.map((m) => ({
    version: m.version,
    name: m.name,
    applied: applied.has(m.version),
  }));
}

export interface MigrateUpOptions {
  /** Stop after applying the migration with this version (inclusive). Default: latest. */
  readonly to?: number;
}

/** Applies pending migrations in order. Returns the versions it applied. */
export function migrateUp(db: Database.Database, opts: MigrateUpOptions = {}): number[] {
  const applied = appliedVersions(db);
  const target = opts.to ?? Number.POSITIVE_INFINITY;
  const appliedNow: number[] = [];
  for (const migration of migrations) {
    if (migration.version > target) break;
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    })();
    appliedNow.push(migration.version);
  }
  return appliedNow;
}

export interface MigrateDownOptions {
  /** How many applied migrations to revert, most recent first. Default: 1. */
  readonly steps?: number;
  /** Revert everything above this version instead of counting steps. */
  readonly to?: number;
}

/** Reverts applied migrations, most recent first. Returns the versions it reverted. */
export function migrateDown(db: Database.Database, opts: MigrateDownOptions = {}): number[] {
  const applied = appliedVersions(db);
  const appliedDesc = migrations
    .filter((m) => applied.has(m.version))
    .sort((a, b) => b.version - a.version);
  const steps = opts.to !== undefined ? Number.POSITIVE_INFINITY : (opts.steps ?? 1);
  const reverted: number[] = [];
  for (const migration of appliedDesc) {
    if (opts.to !== undefined && migration.version <= opts.to) break;
    if (reverted.length >= steps) break;
    db.transaction(() => {
      db.exec(migration.down);
      db.prepare("DELETE FROM _migrations WHERE version = ?").run(migration.version);
    })();
    reverted.push(migration.version);
  }
  return reverted;
}
