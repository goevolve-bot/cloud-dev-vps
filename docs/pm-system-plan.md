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

The contract is **pure convention** — Compose expresses everything the system
needs, so a compliant project carries **no PM-specific config file at all**:

1. **`Dockerfile`** — builds the project.
2. **`compose.yaml`** (or `docker-compose.yml`) — runs the full environment
   (app + db + whatever it needs). The main service must define a
   `healthcheck:`; Verify uses `docker compose up --wait`, so "healthy" is
   Compose-native.
3. **Optional one-shot services `test` and `e2e`** — if present, Verify runs
   them (`docker compose run --rm test`, then `e2e`). A project with an `e2e`
   service counts as a UI project and must write screenshots/videos to
   `./pm-artifacts/`.

Everything is a fixed name (`compose.yaml`/`docker-compose.yml`, services
`test` / `e2e`, artifacts dir `./pm-artifacts/`). No `pm.yml`, no overrides — a
project either follows the convention or an implement run makes it follow the
convention. Keeping it rigid is the point: nothing to learn, nothing to parse.

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

## Isolation model — three trust zones per project (LOCKED)

The security design has two boundaries, not one:

- **Between projects** → the **OS-user** boundary: each project gets its own
  non-root user (`pm-<project>`) with its own rootless dockerd. Project X's
  user cannot see project Y's files, containers, or credentials.
- **Between credentials and everything that runs untrusted code** → the
  **process/container** boundary: the deploy key and provider OAuth token are
  readable *only* by the project user's agent context, and never by (a) the pm
  web app and its npm dependency tree, nor (b) the project's own app
  containers and their dependency tree. A supply-chain compromise in either
  place cannot reach the secrets.

Making (a) true is the reason pm does **not** hold project docker sockets:
socket access equals the ability to `docker run -v ~/.ssh:/x` and read the
key. So each project runs a small **runner** as its own user that owns the
socket and the secrets and exposes only a narrow API to pm.

```
host
├─ user pm  (rootless dockerd A) — the PM app zone
│    pm stack (compose): nginx (TLS + basic auth, 443 only) + pm (Fastify).
│    Holds: SQLite cache, JSONL logs, extracted artifacts, its own npm deps.
│    Holds NO project socket, NO deploy key, NO OAuth token.
│    Talks to each project only via that project's runner control socket.
│
├─ user pm-proj1  (rootless dockerd B) — project runner zone (secrets live here)
│    ~/.ssh/deploy_key            0600, pm-proj1 only  (clone/commit/push)
│    ~/.pm-creds/oauth            0600, pm-proj1 only  (provider login)
│    ~/work/<repo>                the clone (.pm/ tree group-readable by pm)
│    runner  → control socket /srv/pm/runners/proj1/control.sock
│                (dir pm-proj1:pm 2750 — pm connects, other projects can't)
│       verbs: startRun · stopRun · streamLogs · status · commitAndPush
│    ├─ agent container (per run): pm-agent image = git + docker CLI +
│    │    claude + agy, NO project toolchains. Mounts the repo, the dockerd
│    │    socket, and the secrets (ro). This is the only place secrets appear.
│    └─ project workload containers (build, deps, app, db, tests, e2e):
│         the project's own compose stack. Get NO secrets, NO docker socket.
│         All project software runs here — never on the host, never with creds.
└─ user pm-proj2  (rootless dockerd C) — …same shape, fully separate…
```

Key consequences:

- **pm can never read a project's secrets.** It runs as user `pm`, cannot read
  `pm-<project>` homes, and holds no project socket — only the runner's narrow
  control API. Even a compromised pm dependency has nothing to steal.
- **Project code runs only in containers, without credentials.** The agent
  image deliberately lacks language toolchains, so the only way to build/run
  the project is via its rootless daemon; those workload containers never get
  the deploy key, the OAuth token, or the socket. A malicious npm/pip
  dependency in the project is sandboxed away from the secrets and from pm.
- **The agent is the trusted actor.** It runs as the project user with the
  secrets available, keeps the autonomous loop (compose-up, run tests/e2e, fix
  within a run), and does clone/commit/push with the deploy key. Trust
  boundary: we trust the agent (claude/agy) and pm; we do **not** trust
  project dependencies or pm's dependencies.
- **pm reads `.pm/` from the working tree** (group-readable) for the UI, and
  writes task files there, but any git write (commit/push of `.pm/` changes)
  is delegated to the runner's `commitAndPush`, since only it holds the key.
- **Cost**: an active rootless daemon (rootlesskit + dockerd + containerd) is
  ~100–180 MB RSS idle, plus the runner (tiny); disk is the bigger cost since
  each daemon has its own image store (pm-agent ≈ 1.5–2 GB, duplicated per
  project, plus the project's own images). Disk is the price of the boundary;
  RAM is reclaimed by the lifecycle below.

### Project lifecycle — daemons on demand

Project daemons are systemd user services, so a stopped project costs **zero
RAM** (disk only) and restarts in seconds with images/volumes intact:

- **Auto-activate**: queueing any run on a stopped project starts its daemon
  and runner; pm waits for the runner socket, then proceeds (UI: "starting…").
- **Auto-deactivate**: after the last run finishes and an idle timeout passes
  (default 15 min, configurable per project), the runner composes down leftover
  verification environments and the daemon + runner stop.
- **Manual control**: per-project on/off toggle and an "always on" pin in the
  UI, with an `active / idle / stopped` state badge.

Since the pm container can't run `systemctl` for other OS users, everything
privileged goes through the system's single root-touching interface:
**`pm-projectctl`**, a small privileged helper (root systemd service listening
on `/srv/pm/projectctl.sock`, group `pm`, mounted into the pm container) with
a strictly validated verb set:

- `start <project>` / `stop <project>` / `status` — map to
  `systemctl --machine=pm-<project>@.host --user start|stop docker` and the
  project's `runner` user unit.
- `create <project> <git-url>` — the full add-repo mechanics, driven from the
  UI: create the `pm-<name>` non-root user with subuid ranges, set up its
  rootless docker (socket kept private to the user — **not** shared to pm),
  generate the deploy key (0600) and return the public key (the UI shows it
  and waits, like `add-repo` did in the terminal), store the shared provider
  OAuth token into the user's `~/.pm-creds` (0600), clone the repo with the
  key, and scaffold `.pm/` if the repo is empty. Only the runner control
  socket is exposed to pm. Every step is idempotent and the verb is
  **resumable**: a repo the fresh key cannot reach yet returns
  `status: awaiting-key` plus the public key instead of failing, and the same
  call re-issued after the key is authorized picks up at the clone — that is
  what the two-step add-project modal drives.
- `delete <project>` — stop the daemon and remove the user; purging the repo
  volume and image store is a separate explicit flag. The UI requires typed
  confirmation and offers "remove but keep data" vs "purge".

Project names are validated (`[a-z0-9-]`, must exist for start/stop/delete).
The git URL is handled safely against command injection: the helper never
builds a shell string like `sh -c "git clone $url"` (where a URL of
`https://x;rm -rf ~` would run `rm`). Instead it `execve`s git directly with an
argv array — `["git","clone","--",url,dest]` — so the URL is a single opaque
argument git parses itself, never tokens the shell interprets; the leading `--`
also stops a `-`-prefixed URL from being read as a git flag. The scheme is
allow-listed (`https://`, `git@`/`ssh://`) before that. `create`/`delete` widen
the root-touching surface compared to a manual host script — accepted
trade-off for UI-driven onboarding; the helper stays small enough to audit in
one sitting, and a CLI invocation over SSH remains possible for the paranoid
path.

Rootless Docker can't bind ports <1024 by default; Ansible sets
`net.ipv4.ip_unprivileged_port_start=443` so nginx (on the pm daemon) can
publish 443. There is no plaintext :80 listener — Cloudflare (Full strict)
always connects to the origin over HTTPS, so nothing needs port 80.

## Phases and their outcomes

| Phase | Input | Where it happens | Outcome |
|---|---|---|---|
| **Interview** | task description | agent container, workspace ro-intent | JSON array of questions → answer form in the UI |
| **Refine** | description + Q&A answers | agent container | polished description (replaces task description; history kept) |
| **Plan** | description (+ Q&A) | agent container | implementation plan (markdown) attached to task |
| **Implement** | description + plan + prior review/verify findings | agent container on the project daemon: edits, may compose-up + test/e2e itself, commits; runner pushes the branch with the deploy key | commit(s) on task branch pushed to origin |
| **Verify** | task branch | **no agent** — runner checks the task branch out into a fresh volume, `docker compose up --build`, healthcheck, `test`, `e2e`; collects artifacts | pass/fail + logs + **screenshots / video / GIF** in the task UI |
| **Review** | task branch | fresh checkout of the task branch; project env started; agent reviews `git diff main...task-branch` *and* can poke the running app | findings (markdown) → next implement iteration |

Verify auto-runs after every successful implement run (and can be re-run
manually). Its failures are formatted and fed into the next implement prompt.
Non-implement agent phases carry a "do not modify files" instruction and the
workspace is reset afterwards.

**Nothing auto-launches implement.** The only automatic chaining is
implement → verify (a deterministic check, no agent, no code changes). Review
never triggers implement: it *produces findings* and moves the task to
**ready for review**, then stops. Every implement run is an explicit human
launch. So the loop is human-gated at two points:

- **Acceptance** is the human gate. `ready for review` → **done** happens only
  when you click **Accept** (or you kick it back with a comment / a new
  implement run). The agent Review phase is advisory input to *your* decision,
  not an actor that closes or re-opens work.
- Concretely: implement finishes → verify runs → task lands in `ready for
  review` with the diff, verify artifacts, and (if you ran it) review findings
  all visible. You then Accept → done, or launch another implement iteration.
  Optionally a project can enable "auto-run review when entering ready for
  review" so findings are waiting for you — but they remain advisory; the
  Accept click is always yours.

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

Two processes per project + one central app:

- **pm** (Node.js/TypeScript/Fastify, in the `pm` container): REST API
  (`/api/...`), SSE (`/api/runs/:id/events`) for live log tail, static React
  SPA; SQLite (better-sqlite3) cache + JSONL run logs in pm's data dir;
  in-process queue (serial per task, global concurrency limit default 2,
  per-run timeout default 30 min). pm never runs Docker itself — it calls the
  project **runner** over `/srv/pm/runners/<project>.sock`.
- **runner** (small Node/TS process, one per project, runs as `pm-<project>`):
  owns that user's rootless docker socket and the secrets; drives Docker via
  the docker CLI + compose plugin; launches agent + workload containers;
  streams logs back to pm; does git commit/push with the deploy key. Its
  control API is deliberately narrow (startRun / stopRun / streamLogs / status
  / commitAndPush) so pm can orchestrate without ever touching a socket or a
  secret. App restart marks in-flight runs `interrupted`.

### Data model (SQLite — cache + runtime only; `.pm/` in the repo is truth)

- `projects` — id, name, runner_socket, git_url, default_provider,
  default_model, contract (resolved convention + compliance state), lifecycle
  state, always_on
- `tasks`, `comments`, `task_runs` — parsed cache of `.pm/` for fast list,
  search, and rendering; rebuilt from the repo at any time
- `runs` (runtime) — id, task_id, phase, provider, model, prompt, status
  (`queued/running/succeeded/failed/cancelled/interrupted`), exit_code,
  started/finished, log_path (JSONL in pm data dir), artifacts_dir,
  **cost_usd + tokens_in/out** (parsed from the provider's session summary —
  e.g. Claude's final `total_cost_usd`); on completion pm writes the durable
  outcome (including cost) to `.pm/tasks/…/runs/NNNN.md`
- `questions` — id, task_id, run_id, text, answer, answered_at

**Cost roll-ups.** Each run's cost is captured from the provider's own session
report (Claude returns it in the stream-json result; the adapter's
`extractCost` normalizes per provider). The UI shows cost at three levels:
per **run** (in the timeline chip), per **task** (sum of its runs, in the task
header), and per **project** (sum of all tasks, in the project view) — plus a
month-to-date figure. Costs live in the run's `.pm/` file so the totals survive
a cache rebuild and are auditable in git.

### Git flow (host-agnostic)

All git happens under the project user via the runner, with the deploy key —
pm never holds the key and never runs git for a project.

1. First run on a task: the runner creates branch `pm/task-<id>-<slug>` from
   the default branch in a fresh workspace (the agent container's mount).
2. The agent commits in the workspace; the agent context has the key available
   (it's the trusted actor), but project **workload** containers never do.
3. After a successful implement run, the runner's `commitAndPush` pushes the
   branch with the deploy key. Works for GitHub, GitLab, Gitea, bare SSH
   remotes — no forge API, no gh CLI.
4. `.pm/` writes (task moves, comments, run outcomes) go to the **default
   branch** — never onto task branches. To avoid any worktree juggling, the
   runner keeps **one long-lived checkout pinned to the default branch** used
   *only* for `.pm/` (its group-readable working tree is where pm stages
   files); code task branches live in separate per-task workspaces. The two
   never share a working tree, so there is nothing to orchestrate — a `.pm/`
   commit and an agent's code commit can't collide.
5. Verify/review check the pushed task branch out into a **separate fresh
   volume** so they test what was delivered, not a dirty workspace.

**Why `.pm/` on the default branch, not the task branch** (raised in review):
task metadata must be globally true — the board, cost totals, and history can't
depend on which unmerged branch you're looking at, and a `todo` task has no
branch yet. Putting `.pm/` on task branches would scatter the board across
branches and force a merge before any task's state is visible. The cost of
keeping it central is exactly one extra pinned checkout in the runner (above) —
cheaper than the cross-branch reconciliation the alternative needs. So: `.pm/`
central on default; code isolated on task branches.

### Provider adapters

```ts
interface ProviderAdapter {
  containerCmd(opts: { prompt: string; model: string }): string[]; // argv inside pm-agent image
  parseEvents(stdout: Readable): AsyncIterable<RunEvent>;
  extractOutcome(events: RunEvent[]): string;
  extractCost(events: RunEvent[]): { usd: number; tokensIn: number; tokensOut: number } | null;
  models(): Promise<Model[]>; // for the UI provider/model dropdowns
}
```

- **claude**: `claude -p "<prompt>" --model <model> --output-format stream-json
  --verbose --dangerously-skip-permissions`; `extractCost` reads
  `total_cost_usd` / token usage from the final result event.
- **antigravity**: exact unattended flags to be verified via `agy --help` on
  the VPS when the adapter is built; the interface isolates this.

Prompt templates per phase live in `app/server/prompts/` as plain text.

### Provider setup (via UI, not config files)

Providers are configured in a **Settings → Providers** screen, not seeded by
Ansible. Each provider row shows connection status and offers **Connect**:

- OAuth providers (Claude, Antigravity) run a device/login flow; the resulting
  token is written straight into each project user's private `~/.pm-creds`
  (0600) by `pm-projectctl set-credential`, and re-seeded to new projects on
  create. The pm app only ever stores a masked status (`connected`, account
  label, expiry) — never the token, consistent with the isolation model.
- API-key providers accept a pasted key through the same one-way path (UI →
  `pm-projectctl` → project users), and pm keeps only a masked reference.

The screen also lets you pick which models appear in the launch-bar dropdowns
(from each adapter's `models()`), and set the default provider/model per
project.

## Web UI

React SPA (Vite), compact by design — tight paddings, dense lists, space used
for content. Wireframe: `docs/pm-ui-wireframe.html` (v1, agreed layout).

- **Header bar** — project selector dropdown (last entry "+ add project…" →
  two-step modal driving `pm-projectctl create`, showing the deploy pubkey and
  waiting for confirmation); tabs **Tasks / Specs / ADRs**; search over the
  cached index of the current project; daemon state badge
  (`active / idle / stopped`, click to toggle, "always on" pin); a
  **project cost** figure (MTD); a **Settings** menu (Providers, project
  defaults); logout.
- **Left sidebar (Tasks)** — task list grouped by status folder
  (todo / in progress / ready for review / done / blocked), collapsible
  groups, live dot on tasks with a running agent, "+ new task".
- **Main area (task)** — title + status select + branch chip + **task-cost
  chip**; an **Accept** button on `ready for review` tasks (→ done); launch bar
  (phase × provider × model × Run, plus quick-launch buttons per phase);
  markdown description with clipboard handling — pasted image → attachment,
  large text paste → `pasted-NN.md` attachment (as in Claude chats), explicit
  attach button — all stored under the task folder in the repo; **timeline**
  mixing status changes, comments (composer pinned at bottom), and runs — each
  run chip shows its **cost**; running ones tail logs live via SSE with a stop
  button, finished ones render the outcome md, verify entries show the
  **artifacts gallery** (screenshot thumbnails, GIF/video playback, lightbox);
  interview runs render the answer form inline.
- **Settings → Providers** — connect Claude / Antigravity (OAuth or API key),
  see connection status, choose which models populate the launch-bar dropdowns,
  set per-project default provider/model.
- **Specs / ADRs tabs** — file list left (ADRs with status chips; abandoned
  kept and struck through), rendered markdown right, per-file git history
  link.
- **Mobile** — list, task, and run/log become separate screens; sidebar
  becomes a drawer; launch bar collapses.

## Repo layout (this repo)

```
app/
  server/          Fastify app: API, queue, adapters, prompts, migrations
  runner/          per-project runner: docker + git + secrets, narrow control API
  web/             React SPA (Vite)
  agent-image/     Dockerfile for pm-agent (claude, agy, git, docker CLI, and
                   fast search/nav tooling: ripgrep, fd, jq, fzf, bat, delta —
                   no project language toolchains, so project code runs only
                   in containers)
  compose.yaml     pm + nginx stack
  nginx/           nginx conf template, htpasswd handling
  package.json     pnpm workspace root
  scripts/         pm-projectctl (privileged host helper, Ansible-deployed)
roles/
  pm/              deploy the compose stack + pm-projectctl (see below)
```

## Deployment (Ansible)

- **`roles/pm`**: create the `pm` user with its own rootless dockerd (reusing
  the tasks from `docker_rootless.yml`, generalized); create the `pm` group and
  `/srv/pm/runners/` (one `<project>/` subdir per project, owned
  `pm-<project>:pm` 2750, holding that project's control socket); sync
  `app/` to the VPS; build `pm` + `pm-agent` images and bring up the compose
  stack as the `pm` user (systemd user unit wrapping `docker compose up -d`,
  linger enabled); set sysctl `net.ipv4.ip_unprivileged_port_start=443`;
  render nginx conf (incl. the Cloudflare `set_real_ip_from` list) + htpasswd
  from vaulted `pm_auth_password`; install the `pm-projectctl` helper service.
  **No provider creds in Ansible** — providers are connected from the UI (see
  Provider setup) after deploy.
- **TLS: self-signed origin cert; Cloudflare terminates public TLS.** The
  service sits behind Cloudflare, so nginx serves a self-signed origin
  certificate (generated once into a volume) and Cloudflare is set to *Full
  (strict)* against it — no certbot, no Let's Encrypt, no `pm_domain` cert
  dance, and no plaintext :80 listener at all (Cloudflare always connects to
  the origin over HTTPS in this mode). nginx trusts Cloudflare's published IP
  ranges via `set_real_ip_from` + `real_ip_header CF-Connecting-IP` to recover
  the true client IP.
- **`roles/nftables`**: template gains a 443 accept rule, optionally scoped to
  Cloudflare IP ranges so the origin isn't reachable directly.
- No host Node/nginx dependencies — the host needs only rootless Docker
  tooling, which the playbook already provides.

## Build order

1. **Skeleton** — pm + nginx compose stack, `pm-projectctl` (create/start/
   stop/status/delete), the per-project **runner** + its control API,
   add-project modal flow, `.pm/` scaffold + parser + SQLite cache, task CRUD
   writing to the repo, React shell per the wireframe.
2. **Agent image + claude implement path end-to-end** — runner-driven workspace
   prep, agent container lifecycle on the project daemon (secrets in, no
   toolchains), JSONL logs streamed via the runner, SSE live tail, outcome md
   written to `.pm/`, `commitAndPush`. (Already covers the "small bugfix"
   flow.)
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

- Isolation is **two boundaries**: OS user per project (between projects) and
  container/process (secrets vs anything running untrusted code). pm holds no
  project socket and no secret; a per-project **runner** mediates.
- Agent runs use one **generic agent image** with no project language
  toolchains, so all project software (installs, app, tests) runs only in
  containers on the project's rootless daemon.
- Provider credentials (shared subscription login) and the per-project deploy
  key live 0600 in the project user's home, mounted only into the agent
  context — never into pm, never into project workload containers. Fallback to
  per-provider API keys stays open if concurrent OAuth refresh misbehaves.
- Project contract is **pure convention** (compose healthchecks, fixed-name
  `test`/`e2e` services, `./pm-artifacts`) — no `pm.yml`, no overrides.
- **Providers are set up in the UI**, not in Ansible; secrets flow one-way via
  `pm-projectctl` into each project user's private creds, never into the pm
  app.
- **Per-run/task/project cost** is captured from each provider's session report
  and shown in the timeline, task header, and project view (plus MTD).
- **TLS is self-signed at the origin behind Cloudflare** (Full-strict); no
  certbot/Let's Encrypt. nginx basic auth stays as a second factor; firewall
  optionally scoped to Cloudflare IPs.
- Agent image ships **fast tooling** (ripgrep, fd, jq, fzf, bat, delta) but no
  project language toolchains.
- Playwright is the recommended e2e standard; any tool works if it writes
  screenshots/videos to the declared artifacts dir.
- **Review never auto-launches implement**; `ready for review` → `done` is a
  human **Accept**. Agent review findings are advisory.
- `.pm/` writes land on the **default branch**, committed+pushed by the runner
  (pm stages the files, the runner holds the key); audit trail is the git log;
  implementation branches never touch `.pm/`.
- Comments and run outcomes are **markdown with YAML front matter**, not JSON;
  raw JSONL logs and videos stay in pm's data dir with retention.
