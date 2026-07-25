import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { migrations } from "./migrations/index.js";

// Derived from the migration list rather than hard-coded, so adding one is not
// automatically a test failure.
const ALL_UP = migrations.map((m) => m.version);
const ALL_DOWN = [...ALL_UP].reverse();

test("migrateUp creates the schema and migrateDown reverts it", () => {
  const db = openDb(":memory:");
  try {
    assert.deepEqual(migrateUp(db), ALL_UP);
    assert.ok(migrationStatus(db).every((m) => m.applied));

    const insert = db.prepare(
      "INSERT INTO projects (name, git_url, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const { lastInsertRowid } = insert.run(
      "demo",
      "git@example.com:demo.git",
      "stopped",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(lastInsertRowid) as {
      name: string;
    };
    assert.equal(project.name, "demo");

    assert.deepEqual(migrateDown(db, { to: 0 }), ALL_DOWN);
    assert.throws(() => db.prepare("SELECT * FROM projects").all());
  } finally {
    db.close();
  }
});

test("migrateUp is idempotent", () => {
  const db = openDb(":memory:");
  try {
    migrateUp(db);
    assert.deepEqual(migrateUp(db), []);
  } finally {
    db.close();
  }
});

test("migrateDown(to) reverts everything above a version", () => {
  const db = openDb(":memory:");
  try {
    migrateUp(db);
    assert.deepEqual(migrateDown(db, { to: 0 }), ALL_DOWN);
    assert.ok(migrationStatus(db).every((m) => !m.applied));
  } finally {
    db.close();
  }
});
