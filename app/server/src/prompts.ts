import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { listSpecs, listAdrs, slugify, type DiffResult, type TaskRecord } from "@pm/core";

/**
 * Just enough of RunnerClient to ask for a diff. pm never runs git for a
 * project — it has no checkout and the pm image has no git — so the runner
 * produces it.
 */
export interface DiffCapableClient {
  call(verb: "diff", args: { branch: string; base?: string }): Promise<DiffResult>;
}

export async function composePrompt(opts: {
  phase: string;
  task: TaskRecord;
  pmDir: string;
  repoDir: string;
  db: Database.Database;
  projectId: number;
  runnerClient?: DiffCapableClient;
}): Promise<string> {
  const { phase, task, pmDir, db, projectId, runnerClient } = opts;

  // 1. Read the phase prompt template
  const templatePath = join(import.meta.dirname, "../prompts", `${phase}.txt`);
  let template = "";
  try {
    template = await readFile(templatePath, "utf8");
  } catch (err) {
    console.error(`Failed to read prompt template for phase ${phase}:`, err);
    throw err;
  }

  // 2. Gather values
  const description = task.description || "";

  // Q&A
  const qRows = db
    .prepare("SELECT text, answer FROM questions WHERE project_id = ? AND task_num = ? ORDER BY id")
    .all(projectId, task.id) as { text: string; answer: string | null }[];
  let questionsAndAnswers = "";
  if (qRows.length > 0) {
    questionsAndAnswers = qRows
      .map((q) => `Question: ${q.text}\nAnswer: ${q.answer || "Pending answer"}`)
      .join("\n\n");
  } else {
    questionsAndAnswers = "No questions asked.";
  }

  // plan
  let plan = "";
  try {
    plan = await readFile(join(task.dir, "plan.md"), "utf8");
  } catch {
    plan = "No plan available.";
  }

  // findings (verify & review)
  const lastFailedVerify = db
    .prepare(
      "SELECT outcome FROM task_runs WHERE project_id = ? AND task_num = ? AND phase = 'verify' AND status = 'failed' ORDER BY run_num DESC LIMIT 1"
    )
    .get(projectId, task.id) as { outcome: string } | undefined;
  
  const lastReview = db
    .prepare(
      "SELECT outcome FROM task_runs WHERE project_id = ? AND task_num = ? AND phase = 'review' ORDER BY run_num DESC LIMIT 1"
    )
    .get(projectId, task.id) as { outcome: string } | undefined;

  let findingsList: string[] = [];
  if (lastFailedVerify && lastFailedVerify.outcome) {
    findingsList.push(`--- Verify Findings (Failed) ---\n${lastFailedVerify.outcome}`);
  }
  if (lastReview && lastReview.outcome) {
    findingsList.push(`--- Review Findings ---\n${lastReview.outcome}`);
  }
  const findings = findingsList.length > 0 ? findingsList.join("\n\n") : "No prior findings.";

  // git diff (only for review) — asked of the runner, which is the only
  // process with the repo and with git installed.
  let diff = "";
  if (phase === "review") {
    const branchName = `pm/task-${task.id}-${task.slug}`;
    if (!runnerClient) {
      diff = "No changes. (no runner connection was available to produce a diff)";
    } else {
      try {
        const result = await runnerClient.call("diff", { branch: branchName });
        if (!result.found) {
          diff = `No changes. (branch ${branchName} does not exist yet)`;
        } else {
          diff = result.diff.trim() || "No changes.";
        }
      } catch (err: any) {
        diff = `Could not generate git diff: ${err.message}`;
      }
    }
  }

  // specs & ADRs
  const specs = await listSpecs(pmDir);
  const adrs = await listAdrs(pmDir);
  let specsAndAdrs = "";
  if (specs.length > 0) {
    specsAndAdrs += "Specs:\n";
    for (const spec of specs) {
      specsAndAdrs += `\n--- Spec: ${spec.name} ---\n${spec.body}\n`;
    }
  }
  if (adrs.length > 0) {
    specsAndAdrs += "\nArchitecture Decision Records (ADRs):\n";
    for (const adr of adrs) {
      specsAndAdrs += `\n--- ADR: ${adr.id}-${slugify(adr.title)} (Status: ${adr.status}) ---\n${adr.body}\n`;
    }
  }
  if (!specsAndAdrs) {
    specsAndAdrs = "No specs or ADRs available.";
  }

  // 3. Substitute values
  let composed = template
    .replace(/\{\{taskNum\}\}/g, String(task.id))
    .replace(/\{\{taskTitle\}\}/g, task.title)
    .replace(/\{\{description\}\}/g, description)
    .replace(/\{\{questionsAndAnswers\}\}/g, questionsAndAnswers)
    .replace(/\{\{plan\}\}/g, plan)
    .replace(/\{\{findings\}\}/g, findings)
    .replace(/\{\{diff\}\}/g, diff)
    .replace(/\{\{specsAndAdrs\}\}/g, specsAndAdrs);

  // 4. "do not modify files" guard for non-implement phases
  if (phase !== "implement") {
    if (!composed.toLowerCase().includes("do not modify any files")) {
      composed += "\n\nCRITICAL: Do not modify any files in the workspace. This is a read-only phase.";
    }
  } else {
    // For implement phase, check if the project is compliant.
    const project = db.prepare("SELECT contract_json FROM projects WHERE id = ?").get(projectId) as { contract_json: string | null } | undefined;
    let isCompliant = false;
    if (project && project.contract_json) {
      try {
        const parsed = JSON.parse(project.contract_json);
        if (parsed && parsed.isCompliant) {
          isCompliant = true;
        }
      } catch {
        // ignore
      }
    }
    if (!isCompliant) {
      composed += "\n\npart of your job is to make this repo compliant — add the Dockerfile, compose environment with healthcheck, and (for UI projects) e2e tests.";
    }
  }

  return composed;
}

export function parseInterviewQuestions(outcome: string): string[] {
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/i;
  const match = outcome.match(codeBlockRegex);
  const jsonStr = match ? match[1] : outcome;
  try {
    const parsed = JSON.parse(jsonStr.trim());
    if (Array.isArray(parsed)) {
      return parsed.map((q) => String(q).trim()).filter(Boolean);
    }
  } catch {
    try {
      const startBracket = jsonStr.indexOf("[");
      const endBracket = jsonStr.lastIndexOf("]");
      if (startBracket !== -1 && endBracket !== -1 && endBracket > startBracket) {
        const parsed = JSON.parse(jsonStr.slice(startBracket, endBracket + 1).trim());
        if (Array.isArray(parsed)) {
          return parsed.map((q) => String(q).trim()).filter(Boolean);
        }
      }
    } catch {
      // ignore
    }
  }
  return [];
}

