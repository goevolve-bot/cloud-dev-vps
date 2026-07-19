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
- **Cost**: an active rootless daemon (rootlesskit + dockerd + containerd) is
  roughly 100–180 MB RSS idle; disk is the bigger cost since each daemon has
  its own image store (pm-agent ≈ 1.5–2 GB, duplicated per project, plus the
  project's own images/volumes). Disk is the price of the boundary; RAM is
  reclaimed by the lifecycle below.

### Project lifecycle — daemons on demand

Project daemons are systemd user services, so a stopped project costs **zero
RAM** (disk only) and restarts in seconds with images/volumes intact:

- **Auto-activate**: queueing any run on a stopped project starts its daemon;
  pm waits for the socket, then proceeds (UI shows "starting…").
- **Auto-deactivate**: after the last run finishes and an idle timeout passes
  (default 15 min, configurable per project), pm composes down leftover
  verification environments and stops the daemon.
- **Manual control**: per-project on/off toggle and an "always on" pin in the
  UI, with an `active / idle / stopped` state badge.

Since the pm container can't run `systemctl` for other OS users, everything
privileged goes through the system's single root-touching interface:
**`pm-projectctl`**, a small privileged helper (root systemd service listening
on `/srv/pm/projectctl.sock`, group `pm`, mounted into the pm container) with
a strictly validated verb set:

- `start <project>` / `stop <project>` / `status` — map to
  `systemctl --machine=pm-<project>@.host --user start|stop docker`.
- `create <project> <git-url>` — the full add-repo mechanics, driven from the
  UI: create the `pm-<name>` user with subuid ranges, set up rootless docker
  with the extra group socket, generate the deploy key and return the public
  key (the UI shows it and waits, like `add-repo` did in the terminal), then
  clone the repo into a volume and scaffold `.pm/` if the repo is empty.
- `delete <project>` — stop the daemon and remove the user; purging the repo
  volume and image store is a separate explicit flag. The UI requires typed
  confirmation and offers "remove but keep data" vs "purge".

Project names are validated (`[a-z0-9-]`, must exist for start/stop/delete);
git URLs are passed to git only, never a shell. `create`/`delete` widen the
root-touching surface compared to a manual host script — accepted trade-off
for having the whole project onboarding flow in the UI; the helper stays
small enough to audit in one sitting, and a CLI invocation over SSH remains
possible for the paranoid path.

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

## Repo-stored knowledge: tasks, specs, ADRs

The repo is the source of truth for everything durable — tasks, comments, run
outcomes, specs, and decisions all live in a `.pm/` directory, versioned with
the project and readable without the pm system:

```
.pm/
  tasks/
    todo/  in-progress/  ready-for-review/  done/  blocked/
      0012-promo-codes/
        index.md            # front matter: id, created, branch; body = description
        comments/0003.md    # one file per comment: front matter (author, ts) + md body
        runs/0034.md        # per run: front matter (phase, provider, model, status,
                            #   duration, exit) + outcome as md body
        attachments/        # user-pasted images, pasted-NN.md text snippets, files
  specs/                    # living "actual state" docs, one md per area
  adrs/                     # 0007-title.md, front matter status:
                            #   accepted | superseded-by: NNN | abandoned
```

- **Status = folder.** Moving a task is a `git mv`, committed by pm to the
  **default branch** with messages like `pm: task 12 → in-progress`. Statuses:
  `todo / in-progress / ready-for-review / done / blocked`. Implementation
  branches never touch `.pm/` (pm owns it on the default branch), so there are
  no merge conflicts by construction.
- **Markdown everywhere, front matter for machine data** — comments and run
  outcomes are `.md` with YAML front matter: human-readable in any git UI,
  still parseable. Pure JSON is reserved for nothing; it renders poorly and
  diffs worse.
- **Raw execution logs stay out of the repo.** They are huge, noisy JSONL;
  they live in pm's data dir (with retention) keyed by run id, and the repo's
  `runs/NNNN.md` carries the durable outcome + a reference. Same for verify
  videos; small final screenshots may be copied into the run's attachments so
  the repo keeps visual proof.
- **Specs and ADRs are agent context and agent output.** Prompts for every
  phase include relevant specs/ADRs; plan runs may propose ADR drafts and
  implement runs may update specs — reviewed like any other change on the task
  branch, then landing in `.pm/` on merge. Abandoned ADRs are kept (status
  `abandoned`) so the evolution of ideas stays visible.
- **SQLite demotes to cache + runtime state**: an index of `.pm/` for fast
  lists/search (rebuilt by fetch + parse on activation and after each pm
  write) plus live-only data — queue, running containers, SSE streams.

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

### Data model (SQLite — cache + runtime only; `.pm/` in the repo is truth)

- `projects` — id, name, socket_path, git_url, default_provider, default_model,
  contract (resolved convention + optional pm.yml overrides, compliance state),
  lifecycle state, always_on
- `tasks`, `comments`, `task_runs` — parsed cache of `.pm/` for fast list,
  search, and rendering; rebuilt from the repo at any time
- `runs` (runtime) — id, task_id, phase, provider, model, prompt, status
  (`queued/running/succeeded/failed/cancelled/interrupted`), exit_code,
  started/finished, log_path (JSONL in pm data dir), artifacts_dir; on
  completion pm writes the durable outcome to `.pm/tasks/…/runs/NNNN.md`
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

React SPA (Vite), compact by design — tight paddings, dense lists, space used
for content. Wireframe: `docs/pm-ui-wireframe.html` (v1, agreed layout).

- **Header bar** — project selector dropdown (last entry "+ add project…" →
  two-step modal driving `pm-projectctl create`, showing the deploy pubkey and
  waiting for confirmation); tabs **Tasks / Specs / ADRs**; search over the
  cached index of the current project; daemon state badge
  (`active / idle / stopped`, click to toggle, "always on" pin); logout.
- **Left sidebar (Tasks)** — task list grouped by status folder
  (todo / in progress / ready for review / done / blocked), collapsible
  groups, live dot on tasks with a running agent, "+ new task".
- **Main area (task)** — title + status select + branch chip; launch bar
  (phase × provider × model × Run, plus quick-launch buttons per phase);
  markdown description with clipboard handling — pasted image → attachment,
  large text paste → `pasted-NN.md` attachment (as in Claude chats), explicit
  attach button — all stored under the task folder in the repo; **timeline**
  mixing status changes, comments (composer pinned at bottom), and runs —
  running ones tail logs live via SSE with a stop button, finished ones render
  the outcome md, verify entries show the **artifacts gallery** (screenshot
  thumbnails, GIF/video playback, lightbox); interview runs render the answer
  form inline.
- **Specs / ADRs tabs** — file list left (ADRs with status chips; abandoned
  kept and struck through), rendered markdown right, per-file git history
  link.
- **Mobile** — list, task, and run/log become separate screens; sidebar
  becomes a drawer; launch bar collapses.

## Repo layout (this repo)

```
app/
  server/          Fastify + runner + adapters + prompts + migrations
  web/             React SPA (Vite)
  agent-image/     Dockerfile for pm-agent (claude, agy, git, node, uv, docker CLI)
  compose.yaml     pm + nginx stack
  nginx/           nginx conf template, htpasswd handling
  package.json     pnpm workspace root
  scripts/         pm-projectctl (privileged host helper, Ansible-deployed)
roles/
  pm/              deploy the compose stack + pm-projectctl (see below)
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
  the `pm-projectctl` helper service and sync provider creds into
  `/srv/pm/creds/`.
- **`roles/nftables`**: template gains 80/443 accept rules.
- No host Node/nginx dependencies — the host needs only rootless Docker
  tooling, which the playbook already provides.

## Build order

1. **Skeleton** — pm + nginx compose stack, `pm-projectctl` (create/start/
   stop/status/delete), add-project modal flow, `.pm/` scaffold + parser +
   SQLite cache, task CRUD writing to the repo, React shell per the wireframe.
2. **Agent image + claude implement path end-to-end** — workspace volume prep,
   run container lifecycle on the project daemon, JSONL logs, SSE live tail,
   outcome md written to `.pm/`, branch push. (Already covers the "small
   bugfix" flow.)
3. **Verify stage** — fresh checkout, compose up --build, healthcheck, test,
   e2e, artifacts gallery (screenshots/video → GIF via ffmpeg).
4. **Interview / refine / plan / review** — prompt templates, question form,
   description versioning, findings → next iteration; specs/ADR tabs +
   rendering.
5. **Project lifecycle** — auto-activate on queued runs, idle-timeout
   deactivation, UI toggle/pin/badges.
6. **Antigravity adapter.**
7. **Ansible role** — `roles/pm`, firewall change; deploy for real.

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
- `.pm/` writes land on the **default branch** as direct pm commits (audit
  trail is the git log); implementation branches never touch `.pm/`.
- Comments and run outcomes are **markdown with YAML front matter**, not JSON;
  raw JSONL logs and videos stay in pm's data dir with retention.
