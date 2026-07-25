import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { composePrompt, parseInterviewQuestions } from "./prompts.js";
import { createTask, pmDirFor } from "@pm/core";

const execFileAsync = promisify(execFile);

async function setupTempRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "pm-prompt-test-repo-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "# Temp Repo\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });
  return repoDir;
}

test("composePrompt produces correct composed prompt for each phase", async () => {
  const repoDir = await setupTempRepo();
  const pmDir = pmDirFor(repoDir);
  const db = openDb(":memory:");
  migrateUp(db);

  // Insert project
  const projResult = db.prepare(
    "INSERT INTO projects (name, git_url, repo_dir, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("demo", "git@example.com:demo.git", repoDir, "stopped", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  const projectId = Number(projResult.lastInsertRowid);

  // Create a task
  const task = await createTask(pmDir, {
    title: "Implement Auth",
    description: "Build a basic auth system.",
    id: 1,
  });

  try {
    // 1. Interview phase (no questions yet)
    const interviewPrompt = await composePrompt({
      phase: "interview",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
    });
    assert.match(interviewPrompt, /performing the Interview phase for task #1/);
    assert.match(interviewPrompt, /Build a basic auth system\./);
    assert.match(interviewPrompt, /Do not modify any files/i);

    // Let's add some questions (insert mock run first to satisfy foreign key)
    db.prepare(
      "INSERT INTO runs (id, project_id, task_num, phase, provider, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(999, projectId, 1, "interview", "claude", "claude-3-5-sonnet-latest", "succeeded", "2026-01-01T00:00:00Z");

    db.prepare(
      "INSERT INTO questions (project_id, task_num, run_id, text, answer, answered_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(projectId, 1, 999, "What provider should we use?", "OAuth", "2026-01-01T00:00:00Z");
    db.prepare(
      "INSERT INTO questions (project_id, task_num, run_id, text, answer, answered_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(projectId, 1, 999, "Is sign-up required?", null, null);

    // 2. Refine phase (with questions and answers)
    const refinePrompt = await composePrompt({
      phase: "refine",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
    });
    assert.match(refinePrompt, /performing the Refine phase for task #1/);
    assert.match(refinePrompt, /Question: What provider should we use\?\nAnswer: OAuth/);
    assert.match(refinePrompt, /Question: Is sign-up required\?\nAnswer: Pending answer/);
    assert.match(refinePrompt, /Do not modify any files/i);

    // 3. Plan phase (no plan file on disk yet)
    const planPrompt = await composePrompt({
      phase: "plan",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
    });
    assert.match(planPrompt, /performing the Plan phase for task #1/);

    // Write a plan file
    await writeFile(join(task.dir, "plan.md"), "# Implementation Plan\n1. Setup oauth\n");

    // Re-run plan phase check
    const planPromptWithPlan = await composePrompt({
      phase: "plan",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
    });
    // planPrompt doesn't embed plan, but implementPrompt does
    const implementPromptNonCompliant = await composePrompt({
      phase: "implement",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
    });
    assert.match(implementPromptNonCompliant, /performing the Implement phase/);
    assert.match(implementPromptNonCompliant, /part of your job is to make this repo compliant/);
    assert.match(implementPromptNonCompliant, /Setup oauth/);

    // Mark project compliant in DB
    db.prepare("UPDATE projects SET contract_json = ? WHERE id = ?").run(
      JSON.stringify({ isCompliant: true }),
      projectId
    );
    const implementPromptCompliant = await composePrompt({
      phase: "implement",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
    });
    assert.match(implementPromptCompliant, /performing the Implement phase/);
    assert.ok(!implementPromptCompliant.includes("part of your job is to make this repo compliant"));

    // 5. Review phase (with git diff)
    // Create task branch and make a modification
    await execFileAsync("git", ["checkout", "-b", "pm/task-1-implement-auth"], { cwd: repoDir });
    await writeFile(join(repoDir, "auth.js"), "console.log('auth');\n");
    await execFileAsync("git", ["add", "auth.js"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "add auth file"], { cwd: repoDir });
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    // The diff is produced by the runner, which is the only process with the
    // repo (and with git installed at all) — pm just asks for it.
    const runnerClient = {
      call: async (_verb: "diff", args: { branch: string }) => {
        const base = (
          await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir })
        ).stdout.trim();
        const diff = (
          await execFileAsync("git", ["diff", `${base}...${args.branch}`], { cwd: repoDir })
        ).stdout;
        return { branch: args.branch, base, diff, found: true };
      },
    };

    const reviewPrompt = await composePrompt({
      phase: "review",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
      runnerClient,
    });
    assert.match(reviewPrompt, /performing the Review phase/);
    assert.match(reviewPrompt, /diff --git/);
    assert.match(reviewPrompt, /console\.log\('auth'\)/);

    // Without a runner there is no diff to be had — and pm must not try to run
    // git itself to compensate.
    const reviewPromptNoRunner = await composePrompt({
      phase: "review",
      task,
      pmDir,
      repoDir,
      db,
      projectId,
    });
    assert.match(reviewPromptNoRunner, /No changes\./);
    assert.ok(!reviewPromptNoRunner.includes("diff --git"));
  } finally {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("parseInterviewQuestions extracts questions from different formats", () => {
  
  const outcome1 = `
Here are the questions:
\`\`\`json
[
  "What is the target load?",
  "Should we use cookies?"
]
\`\`\`
  `;
  assert.deepEqual(parseInterviewQuestions(outcome1), [
    "What is the target load?",
    "Should we use cookies?"
  ]);

  const outcome2 = `["Only one question?"]`;
  assert.deepEqual(parseInterviewQuestions(outcome2), ["Only one question?"]);

  const outcome3 = "Just conversational text with no JSON array";
  assert.deepEqual(parseInterviewQuestions(outcome3), []);
});

