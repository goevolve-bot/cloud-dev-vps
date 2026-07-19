# PM System — Implementation Plan

A dead-simple project management system that runs on the dev VPS and drives
coding agents (Claude Code, Antigravity) in unattended mode. Each repo is a
project; each task moves through optional agent-driven phases; every agent run
produces a logged, inspectable outcome attached to the task.

## Core ideas

- **Project = repo.** A project points at an existing clone on the VPS
  (typically created with `add-repo`).
- **Task = unit of work.** Free-text title + description, evolving as phases run.
- **Run = one unattended agent invocation.** Every run records: phase, provider,
  model, the full composed prompt, full logs, and a parsed **outcome**.
- **Phases are optional and user-launched.** A small bugfix can go straight to
  *implement*. A bigger feature can go interview → refine → plan → implement →
  review → implement (iterate).
- **User picks provider + model for every run** from dropdowns (per-provider
  model list in config; project can set defaults).

## Phases and their outcomes

| Phase | Input | Agent behavior | Outcome |
|---|---|---|---|
| **Interview** | task description | explores repo read-only, finds ambiguities | JSON array of questions → rendered as an answer form in the UI |
| **Refine** | description + Q&A answers | rewrites the task description | polished description (replaces task description; old one kept in run history) |
| **Plan** | description (+ Q&A) | explores repo, designs approach | implementation plan (markdown) attached to task |
| **Implement** | description + plan (if any) + review findings (if any) | edits code in the task worktree, commits | commit(s) on task branch; system pushes and opens/updates a GitHub PR; outcome = summary + PR link + diffstat |
| **Review** | diff of task branch vs main | reviews the diff | findings (markdown); feed into the next implement run |

Non-implement phases run with an explicit "do not modify files" instruction and
any stray working-tree changes are reset afterwards.

## Architecture

Single Node.js process (TypeScript, Fastify) running as `{{ dev_user }}` under
systemd, behind nginx.

```
nginx (443, basic auth, TLS)
  └─ Fastify on 127.0.0.1:3000
       ├─ REST API (/api/...)
       ├─ SSE (/api/runs/:id/events) — live log streaming
       ├─ static React SPA (built, served from disk)
       └─ Runner: spawns agent CLIs, one queue
SQLite (better-sqlite3) at ~/.pm/pm.db
Logs as JSONL files at ~/.pm/logs/<run-id>.jsonl
Worktrees at ~/.pm/worktrees/<task-id>/
```

No background daemon besides the app itself; the queue is in-process. If the
app restarts mid-run, the run is marked `interrupted` and can be relaunched.

### Data model (SQLite)

- `projects` — id, name, repo_path, github_slug, default_provider, default_model
- `tasks` — id, project_id, title, description (current version), status
  (`open` / `done` / `archived`), branch_name, pr_url, created/updated
- `runs` — id, task_id, phase, provider, model, prompt, status
  (`queued/running/succeeded/failed/cancelled/interrupted`), exit_code,
  started/finished, log_path, outcome_md, outcome_json
- `questions` — id, task_id, run_id, text, answer, answered_at

### Runner and provider adapters

Common interface, one adapter per provider:

```ts
interface ProviderAdapter {
  spawn(opts: { prompt: string; model: string; cwd: string }): ChildProcess;
  parseEvents(stdout: Readable): AsyncIterable<RunEvent>; // → JSONL log + SSE
  extractOutcome(events: RunEvent[]): string;             // final result text
}
```

- **claude**: `claude -p "<prompt>" --model <model> --output-format stream-json
  --verbose --dangerously-skip-permissions`, cwd = task worktree. Bypass
  permissions is already configured by this playbook.
- **antigravity**: same shape; exact non-interactive flags to be verified on the
  VPS (`agy --help`) when the adapter is built — the adapter interface isolates
  this uncertainty.

Rules: runs on one task are serial; global concurrency limit (default 2);
per-run timeout (default 30 min, configurable); cancel = SIGTERM then SIGKILL.
stdout/stderr events stream to the JSONL log and to any connected SSE client;
the UI shows a live tail and the full log is always attached to the run.

### Prompt composition

Prompts are composed server-side from templates per phase, embedding: task
title/description, answered Q&A, latest plan, latest review findings, and
phase-specific instructions (e.g. interview must output
`{"questions": ["..."]}` as its final message; implement must commit its work
with a descriptive message). Templates live in `app/server/prompts/` as plain
text files so they are easy to tweak without touching code.

### Git / GitHub flow (implement phase)

1. First implement run for a task: `git worktree add ~/.pm/worktrees/<task-id>
   -b pm/task-<id>-<slug>` from the project repo's default branch (fetched
   first). Later runs reuse the worktree/branch.
2. Agent works and commits in the worktree.
3. After a successful run the system pushes the branch (repo's existing
   deploy-key SSH config from `add-repo` handles auth) and creates the PR via
   GitHub REST API on the first push, updating the task with the PR URL.
   Deploy keys cannot call the API, so PR creation uses a `GITHUB_TOKEN`
   (fine-grained PAT) from the app's env file.
4. Review phase runs against `git diff <default-branch>...<task-branch>` in the
   same worktree.

## Web UI

React SPA (Vite), responsive single-column-first layout so it works on mobile
without extra work.

- **Projects** — list + "add project" (pick a repo path on the server).
- **Project view** — task list with status filters; new-task form (title +
  description).
- **Task view** — the heart of the app:
  - editable description (markdown rendered / edit toggle)
  - **launch bar**: phase picker × provider picker × model picker × Run button
  - timeline of runs (newest first), each expandable: outcome rendered as
    markdown, log viewer (live tail via SSE while running)
  - interview answers form when unanswered questions exist
  - plan viewer, review findings, PR link + diffstat

## Repo layout (this repo)

```
app/
  server/        Fastify + runner + adapters + prompts + migrations
  web/           React SPA (Vite)
  package.json   pnpm workspace root
roles/
  pm/            deploy app as systemd service (see below)
  nginx/         reverse proxy + TLS + basic auth
```

## Deployment (Ansible)

- **`roles/pm`**: rsync `app/` to the VPS, `pnpm install && pnpm build` there
  (Node already provisioned), install systemd unit `pm.service` running as
  `{{ dev_user }}`, `EnvironmentFile=/etc/pm/env` (holds `GITHUB_TOKEN`,
  vaulted in group_vars), listens on 127.0.0.1:3000.
- **`roles/nginx`**: install nginx, proxy `pm_domain` → 127.0.0.1:3000 with
  SSE-friendly settings (`proxy_buffering off`), TLS via certbot when
  `pm_domain` is set (falls back to self-signed otherwise), HTTP basic auth
  from a vaulted `pm_auth_password` var. nginx adds no access for unauthed
  users beyond the auth prompt.
- **`roles/nftables`**: template gains 80/443 accept rules.

## Build order

1. **Skeleton** — Fastify + SQLite migrations + React shell; project & task CRUD.
2. **Claude implement path end-to-end** — worktree creation, runner, JSONL logs,
   SSE live tail, outcome capture. (This alone already covers the
   "small bugfix, no interview/plan" flow.)
3. **Push + PR** — deploy-key push, PR create/update via token.
4. **Interview / refine / plan / review** — prompt templates, question form,
   description versioning, review-findings → next implement iteration.
5. **Antigravity adapter** — verify `agy` unattended flags, implement adapter.
6. **Ansible roles** — `pm`, `nginx`, firewall change; deploy for real.

## Defaults chosen (flag if you disagree)

- Basic auth (single user) at nginx is the only auth layer; the app itself is
  single-user and trusts the proxy.
- TLS via Let's Encrypt requires a domain (`pm_domain` var); until one is set,
  self-signed cert.
- Model lists per provider live in a small config file, editable without a UI.
- No CI for `app/` initially; typecheck + a smoke test run locally/on the VPS.
