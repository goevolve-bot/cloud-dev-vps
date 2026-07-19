# PM System — Implementation Plan

A dead-simple project management system that runs on the dev VPS and drives
coding agents (Claude Code, Antigravity) in unattended mode. Each git repo is a
project; each task moves through optional agent-driven phases; every agent run
produces a logged, inspectable outcome attached to the task.

Everything runs in Docker: the system itself is a compose stack, and **every
agent run executes in its own container**. Git hosting is not assumed — any
remote a repo's `origin` points at works. There are no pull requests: the unit
of delivery is a **branch per task**, verified by actually building and running
the project's own Docker environment.

## Core ideas

- **Project = repo.** A project points at a clone on the VPS — any repo,
  including an empty one. To be *verifiable* it must satisfy the **project
  contract** (below) — at minimum it runs under Docker.
- **Task = unit of work.** Free-text title + description, evolving as phases run.
- **Run = one unattended agent invocation in a fresh container.** Every run
  records: phase, provider, model, the full composed prompt, full logs, and a
  parsed **outcome**.
- **Phases are optional and user-launched.** A small bugfix goes straight to
  *implement*. A bigger feature: interview → refine → plan → implement →
  verify → review → implement (iterate).
- **User picks provider + model for every run** from dropdowns (per-provider
  model list in config; project can set defaults).
- **Delivery = task branch + green verification + visual proof** (screenshots /
  video for UI projects). Merging is the user's manual act, wherever the repo
  is hosted.

## Project contract

The contract is **convention over configuration** — Compose can express nearly
everything the system needs, so most projects require zero PM-specific files:

1. **`Dockerfile`** — builds the project.
2. **`compose.yaml`** (or `docker-compose.yml`) — runs the full environment
   (app + db + whatever it needs). The main service must define a
   `healthcheck:`; Verify uses `docker compose up --wait`, so "healthy" is
   Compose-native.
3. **Optional one-shot services `test` and `e2e`** — if present, Verify runs
   them (`docker compose run --rm test`, then `e2e`). A project with an `e2e`
   service counts as a UI project and must write screenshots/videos to
   `./pm-artifacts/`.
4. **`pm.yml`** — *optional* override, only for repos that can't follow the
   convention (different compose filename, service names, artifacts dir).

**UI projects must have e2e tests** (Playwright is the recommended standard —
it natively produces screenshots and videos); the system surfaces the
artifacts in the task UI, converting videos to GIF/webm previews (ffmpeg) so
every implementation ends with something you can *see*.

**The contract is enforced at verify time, not registration.** Any repo can be
registered — including an empty one, which is the natural way to start a new
project. The UI shows a compliance badge, and while a repo is non-compliant,
every implement prompt automatically includes: *part of your job is to make
this repo compliant — add the Dockerfile, compose environment with
healthcheck, and (for UI projects) e2e tests.* The first task on an empty repo
is thus a bootstrap task; Verify unlocks the moment the contract is met, which
doubles as that task's definition of done.

## Container topology — one rootless daemon per project

With rootless Docker, **the socket is the security boundary**: anyone holding a
daemon's socket can act as that daemon's OS user. So project isolation means
**one OS user + one rootless dockerd per project**, plus one for the pm system
itself. An agent working on project X holds only X's socket and can therefore
only touch X's containers, volumes, and files — never another project, never
the pm database.

```
host
├─ user pm            → rootless dockerd A
│    pm stack (compose):
│      nginx — TLS + basic auth, publishes 80/443
│      pm   — Fastify app; mounts /srv/pm/sockets/ (all project sockets)
│             and its own data dir (db, logs, extracted artifacts)
├─ user pm-<proj1>    → rootless dockerd B   (socket /srv/pm/sockets/proj1.sock)
│    ├─ agent run containers (one per run, auto-removed):
│    │    image pm-agent; mounts: task workspace volume (rw),
│    │    proj1's own socket, provider creds (ro). No other project visible.
│    ├─ per-task verification environments (project compose stack,
│    │    unique name pm-t<task>-r<run>, no host-published ports)
│    └─ utility containers (git checkout / push / docker cp jobs run by pm)
└─ user pm-<proj2>    → rootless dockerd C   (…same shape…)
```

Key consequences of this design:

- **pm's only interface to a project is that project's socket.** Each rootless
  dockerd listens on an extra socket at `/srv/pm/sockets/<project>.sock`
  (group `pm`, mode 0660). pm never touches project users' homes: run logs
  stream via `docker logs`/attach, task workspaces and verify checkouts are
  **named volumes** on the project daemon (which also kills the
  sibling-container path-mapping problem), and artifacts are pulled out with
  `docker cp` into pm's data dir for serving.
- **Agents keep the autonomous loop, scoped to their project**: an implement
  run can compose-up the project, run tests/e2e, see failures, and fix them
  within a single run — on its own daemon only.
- **Deploy keys are per-project and live with the project user** (the
  `add-repo` model). Pushes run in a utility container on the project daemon.
  Worst case an agent extracts *its own project's* deploy key — blast radius
  stays inside the project it already controls.
- **Provider credentials are the one shared thing** (your Claude/Antigravity
  logins), mounted read-only from `/srv/pm/creds/` (group `pm-projects`). Any
  agent can use them — inherent to sharing a subscription. If concurrent OAuth
  token refresh across daemons proves flaky, fall back to per-provider API
  keys (open item).
- **Cost**: each rootless dockerd has its own memory footprint and image
  store (the pm-agent image is duplicated per project). Fine for a handful of
  projects on a VPS; it's the price of the boundary.

A host script **`pm-add-project <name> <git-url>`** (Ansible-deployed, run as
root over SSH — same workflow as `add-repo`) does the privileged setup: create
the `pm-<name>` user with subuid ranges, install/enable rootless docker with
the extra group socket, generate the deploy key (prints pubkey, waits like
`add-repo`), clone the repo into a volume, and drop the socket in
`/srv/pm/sockets/`. The pm app then discovers the new socket and the project
appears in the UI — the app itself needs no root and cannot create users.

Rootless Docker can't bind ports <1024 by default; Ansible sets
`net.ipv4.ip_unprivileged_port_start=80` so nginx (on the pm daemon) can
publish 80/443.

## Phases and their outcomes

| Phase | Input | Where it happens | Outcome |
|---|---|---|---|
| **Interview** | task description | agent container, workspace ro-intent | JSON array of questions → answer form in the UI |
| **Refine** | description + Q&A answers | agent container | polished description (replaces task description; history kept) |
| **Plan** | description (+ Q&A) | agent container | implementation plan (markdown) attached to task |
| **Implement** | description + plan + prior review/verify findings | agent container with socket: edits, may compose-up + test/e2e itself, commits | commit(s) on task branch; pm pushes branch to origin |
| **Verify** | task branch | **no agent** — deterministic: fresh checkout of the task branch, `docker compose up --build`, healthcheck, `test`, `e2e`; collect artifacts | pass/fail + logs + **screenshots / video / GIF** in the task UI |
| **Review** | task branch | fresh checkout of the task branch; project env started; agent reviews `git diff main...task-branch` *and* can poke the running app | findings (markdown) → next implement iteration |

Verify auto-runs after every successful implement run (and can be re-run
manually). Its failures are formatted and fed into the next implement prompt.
Non-implement agent phases carry a "do not modify files" instruction and the
workspace is reset afterwards.

## Architecture

Single Node.js (TypeScript, Fastify) app in the `pm` container:

- REST API (`/api/...`), SSE (`/api/runs/:id/events`) for live log tail,
  static built React SPA.
- SQLite (better-sqlite3) at `~/.pm/pm.db`; run logs as JSONL at
  `~/.pm/logs/<run>.jsonl`.
- Runner drives Docker via the docker CLI + compose plugin (installed in the
  pm image), selecting the target project with
  `DOCKER_HOST=unix:///srv/pm/sockets/<project>.sock` — same commands agents
  and humans use, easy to debug.
- In-process queue: serial per task, global concurrency limit (default 2),
  per-run timeout (default 30 min), cancel = stop container. App restart marks
  in-flight runs `interrupted`.

### Data model (SQLite)

- `projects` — id, name, socket_path, git_url, default_provider, default_model,
  contract (resolved convention + optional pm.yml overrides, compliance state)
- `tasks` — id, project_id, title, description, status (`open/done/archived`),
  branch_name
- `runs` — id, task_id, phase, provider, model, prompt, status
  (`queued/running/succeeded/failed/cancelled/interrupted`), exit_code,
  started/finished, log_path, outcome_md, outcome_json, artifacts_dir
- `questions` — id, task_id, run_id, text, answer, answered_at

### Git flow (host-agnostic)

All git operations happen in utility containers on the project's daemon,
against named volumes — pm never touches a filesystem path directly.

1. First run on a task: pm runs a git utility container on the project daemon
   that clones from the project's mirror volume (kept fresh by fetches),
   creates branch `pm/task-<id>-<slug>` from the default branch in a new
   workspace volume `pm-task-<id>`. Later runs reuse the volume.
2. Agent commits in the workspace volume (its container has no deploy key).
3. After a successful implement run, pm launches a push container (same
   daemon, deploy key mounted from the project user's home) to push the
   branch. Works for GitHub, GitLab, Gitea, bare SSH remotes — no forge API,
   no gh CLI.
4. Verify/review check the pushed branch out into a **separate fresh volume**
   so they test what was actually delivered, not the agent's dirty workspace.

### Provider adapters

```ts
interface ProviderAdapter {
  containerCmd(opts: { prompt: string; model: string }): string[]; // argv inside pm-agent image
  parseEvents(stdout: Readable): AsyncIterable<RunEvent>;
  extractOutcome(events: RunEvent[]): string;
}
```

- **claude**: `claude -p "<prompt>" --model <model> --output-format stream-json
  --verbose --dangerously-skip-permissions`.
- **antigravity**: exact unattended flags to be verified via `agy --help` on
  the VPS when the adapter is built; the interface isolates this.

Prompt templates per phase live in `app/server/prompts/` as plain text.

## Web UI

React SPA (Vite), responsive single-column-first (desktop and mobile from the
same layout).

- **Projects** — list; new projects appear automatically once
  `pm-add-project` has been run on the host (compliance badge shown, empty
  repos welcome).
- **Project view** — task list + filters; new-task form.
- **Task view** — the heart:
  - editable description (markdown), launch bar (phase × provider × model × Run)
  - run timeline, each run expandable: outcome markdown, live log tail (SSE)
  - interview answer form; plan viewer; verify results with an **artifacts
    gallery** (screenshots inline, video/GIF playback); review findings;
    branch name + diffstat

## Repo layout (this repo)

```
app/
  server/          Fastify + runner + adapters + prompts + migrations
  web/             React SPA (Vite)
  agent-image/     Dockerfile for pm-agent (claude, agy, git, node, uv, docker CLI)
  compose.yaml     pm + nginx stack
  nginx/           nginx conf template, htpasswd handling
  package.json     pnpm workspace root
  scripts/         pm-add-project (host script, Ansible-deployed)
roles/
  pm/              deploy the compose stack + pm-add-project (see below)
```

## Deployment (Ansible)

- **`roles/pm`**: create the `pm` user with its own rootless dockerd (reusing
  the tasks from `docker_rootless.yml`, generalized); create the `pm` and
  `pm-projects` groups and `/srv/pm/{sockets,creds}`; sync `app/` to the VPS;
  build `pm` + `pm-agent` images and bring up the compose stack as the `pm`
  user (systemd user unit wrapping `docker compose up -d`, linger enabled);
  set sysctl `net.ipv4.ip_unprivileged_port_start=80`; render nginx conf +
  htpasswd from vaulted `pm_auth_password`; TLS certs in a volume — certbot
  sidecar when `pm_domain` is set, self-signed fallback otherwise; install
  `pm-add-project` to `/usr/local/sbin` and sync provider creds into
  `/srv/pm/creds/`.
- **`roles/nftables`**: template gains 80/443 accept rules.
- No host Node/nginx dependencies — the host needs only rootless Docker
  tooling, which the playbook already provides.

## Build order

1. **Skeleton** — pm + nginx compose stack, `pm-add-project` script, socket
   discovery, compliance detection, task CRUD, SQLite migrations, React shell.
2. **Agent image + claude implement path end-to-end** — workspace volume prep,
   run container lifecycle on the project daemon, JSONL logs, SSE live tail,
   outcome capture, branch push. (Already covers the "small bugfix" flow.)
3. **Verify stage** — fresh checkout, compose up --build, healthcheck, test,
   e2e, artifacts gallery (screenshots/video → GIF via ffmpeg).
4. **Interview / refine / plan / review** — prompt templates, question form,
   description versioning, findings → next iteration.
5. **Antigravity adapter.**
6. **Ansible role** — `roles/pm`, firewall change; deploy for real.

## Defaults chosen (flag if you disagree)

- Agent runs use one **generic agent image**; the project's own containers are
  used for running/verifying the app, not for hosting the agent.
- Agent containers **get their own project's rootless socket only** so they can
  iterate on the real environment within a run without reaching other projects.
- Provider credentials via **read-only mounts of host CLI configs** (~/.claude,
  ~/.gemini/antigravity-cli), not API keys.
- Project contract is **convention-first** (compose healthchecks, `test`/`e2e`
  services, `./pm-artifacts`), with `pm.yml` as an optional override only.
- nginx basic auth (single user) is the only auth layer; the app trusts the
  proxy. TLS needs `pm_domain` for Let's Encrypt; self-signed until then.
- Playwright is the recommended e2e standard; any tool works if it writes
  screenshots/videos to the declared artifacts dir.
