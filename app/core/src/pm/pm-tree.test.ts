import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeAdr, listAdrs } from "./adrs.js";
import { writeSpec, readSpec, listSpecs } from "./specs.js";
import {
  addComment,
  addRunOutcome,
  createTask,
  listAttachments,
  listComments,
  listRuns,
  listTasks,
  moveTaskStatus,
  nextPastedName,
  readTask,
  setTaskBranch,
  writeAttachment,
  writeTaskDescription,
} from "./tasks.js";

async function withPmDir(fn: (pmDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pm-model-test-"));
  try {
    await fn(join(dir, ".pm"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a task round-trips through create, read, and list", () =>
  withPmDir(async (pmDir) => {
    const description = "Add a promo code field to checkout.\n";
    const created = await createTask(pmDir, {
      title: "Promo Codes",
      description,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    assert.equal(created.id, 1);
    assert.equal(created.slug, "promo-codes");
    assert.equal(created.status, "todo");

    const reread = await readTask(pmDir, "todo", "0001-promo-codes");
    assert.deepEqual(reread, created);

    const listed = await listTasks(pmDir);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], created);
  }));

test("a second task gets the next id even across status folders", () =>
  withPmDir(async (pmDir) => {
    await createTask(pmDir, { title: "First", description: "one\n", status: "done" });
    const second = await createTask(pmDir, { title: "Second", description: "two\n" });
    assert.equal(second.id, 2);
  }));

test("writeTaskDescription and setTaskBranch persist and keep the front matter", () =>
  withPmDir(async (pmDir) => {
    const created = await createTask(pmDir, { title: "Promo Codes", description: "v1\n" });
    const withNewDescription = await writeTaskDescription(created, "v2\n");
    await setTaskBranch(withNewDescription, "pm/task-1-promo-codes");

    const reread = await readTask(pmDir, "todo", "0001-promo-codes");
    assert.equal(reread.description, "v2\n");
    assert.equal(reread.branch, "pm/task-1-promo-codes");
    assert.equal(reread.title, "Promo Codes");
  }));

test("moveTaskStatus relocates the folder and readTask finds it there", () =>
  withPmDir(async (pmDir) => {
    const task = await createTask(pmDir, { title: "Promo Codes", description: "d\n" });
    const moved = await moveTaskStatus(pmDir, task, "in-progress");
    assert.equal(moved.status, "in-progress");

    const listed = await listTasks(pmDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "in-progress");
    assert.equal(listed[0].id, task.id);
  }));

test("comments accumulate with sequential numbers and round-trip their body", () =>
  withPmDir(async (pmDir) => {
    const task = await createTask(pmDir, { title: "Promo Codes", description: "d\n" });
    const c1 = await addComment(task, { author: "alice", body: "first comment" });
    const c2 = await addComment(task, { body: "second, no author" });
    assert.equal(c1.num, 1);
    assert.equal(c2.num, 2);

    const comments = await listComments(task);
    assert.equal(comments.length, 2);
    assert.equal(comments[0].author, "alice");
    assert.equal(comments[0].body, "first comment\n");
    assert.equal(comments[1].author, null);
  }));

test("run outcomes round-trip their front matter and markdown outcome", () =>
  withPmDir(async (pmDir) => {
    const task = await createTask(pmDir, { title: "Promo Codes", description: "d\n" });
    await addRunOutcome(
      task,
      {
        phase: "implement",
        provider: "claude",
        model: "claude-sonnet-5",
        status: "succeeded",
        costUsd: 0.42,
        tokensIn: 1000,
        tokensOut: 200,
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:05:00Z",
      },
      "Implemented the promo code field and added a test.",
    );

    const runs = await listRuns(task);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].num, 1);
    assert.equal(runs[0].frontMatter.status, "succeeded");
    assert.equal(runs[0].frontMatter.costUsd, 0.42);
    assert.match(runs[0].outcome, /Implemented the promo code field/);
  }));

test("attachments and nextPastedName give unique sequential names", () =>
  withPmDir(async (pmDir) => {
    const task = await createTask(pmDir, { title: "Promo Codes", description: "d\n" });
    const firstName = await nextPastedName(task);
    assert.equal(firstName, "pasted-0001.md");
    await writeAttachment(task, firstName, "a big pasted snippet");
    const secondName = await nextPastedName(task);
    assert.equal(secondName, "pasted-0002.md");
    await writeAttachment(task, "screenshot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const attachments = await listAttachments(task);
    assert.deepEqual(attachments, ["pasted-0001.md", "screenshot.png"]);
    assert.equal(
      await readFile(join(task.dir, "attachments", "pasted-0001.md"), "utf8"),
      "a big pasted snippet",
    );
  }));

test("specs round-trip through write, read, and list", () =>
  withPmDir(async (pmDir) => {
    await writeSpec(pmDir, "auth", "# Auth\n\nCurrent state of authentication.");
    const spec = await readSpec(pmDir, "auth");
    assert.equal(spec.body, "# Auth\n\nCurrent state of authentication.\n");

    const specs = await listSpecs(pmDir);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].name, "auth");
  }));

test("ADRs round-trip status and supersededBy through front matter", () =>
  withPmDir(async (pmDir) => {
    const first = await writeAdr(pmDir, {
      title: "Use SQLite for the cache",
      body: "Because it's simple.",
    });
    assert.equal(first.id, 1);
    assert.equal(first.status, "accepted");

    await writeAdr(pmDir, {
      title: "Use Postgres instead",
      status: "accepted",
      body: "Reconsidered.",
    });
    await writeAdr(pmDir, {
      id: first.id,
      title: first.title,
      status: "superseded",
      supersededBy: 2,
      body: first.body,
    });

    const adrs = await listAdrs(pmDir);
    assert.equal(adrs.length, 2);
    const superseded = adrs.find((a) => a.id === 1);
    assert.equal(superseded?.status, "superseded");
    assert.equal(superseded?.supersededBy, 2);
  }));
