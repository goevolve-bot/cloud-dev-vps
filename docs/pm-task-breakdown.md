# PM System — Task Breakdown

Every task below is scoped to be completable in **one unattended agent session**
(Claude Code or Antigravity): a coherent slice with clear done-criteria, no
mid-task human decision required. Tasks are ordered by dependency; within a
milestone, items sharing the same deps can run in parallel.

**Effort levels**

- **S — Small**: one narrow deliverable, low risk, few files.
- **M — Medium**: several moving parts or one integration seam.
- **L — Large**: the ceiling for a single unattended session — touches several
  files and a real integration; higher failure risk, so it should end by
  running Verify. If an L task overruns in practice, split it at the noted
  seam.

Dependencies use task IDs. "—" means none beyond the repo scaffold.

---

## M0 · Scaffolding

| ID | Task | Effort | Deps |
|----|------|--------|------|
| T01 | **pnpm monorepo scaffold** — workspaces `server/`, `runner/`, `web/`, shared `core/` (types + `.pm` model); TS config, eslint/prettier, root scripts. Done: `pnpm -r build` and `pnpm -r typecheck` pass on empty packages. | S | — |
| T02 | **pm compose stack skeleton** — `compose.yaml` (pm + nginx), pm Dockerfile (node), nginx conf (basic auth, SSE-friendly `proxy_buffering off`), self-signed origin cert generated into a volume. Done: `docker compose up` serves a health page over TLS with basic auth. | M | T01 |
| T03 | **pm-agent image** — Dockerfile with claude, agy, git, docker CLI + compose plugin, ripgrep/fd/jq/fzf/bat/delta; **no** language toolchains. Done: image builds; `claude --version`, `agy --version`, `rg --version` run inside it. | S | — |

## M1 · Control plane skeleton

| ID | Task | Effort | Deps |
|----|------|--------|------|
| T04 | **SQLite layer + migrations** — better-sqlite3, migration runner, schema for `projects`, `tasks`/`comments`/`task_runs` (cache), `runs` (runtime), `questions`. Done: migrate up/down; smoke insert/select test. | M | T01 |
| T05 | **`.pm/` model library** (in `core/`) — read/write task folders, front-matter markdown (comments, runs), specs, ADRs, attachments; slug/id helpers. Done: unit tests round-trip a sample `.pm/` tree. | M | T01 |
| T06 | **`.pm/` ↔ SQLite indexer** — full scan + incremental re-index after a write; rebuild-from-repo path. Done: given a `.pm/` fixture, cache tables match; editing a file updates the row. | M | T04, T05 |
| T07 | **`pm-projectctl` core** — root systemd service on a group socket; verb dispatch; strict name (`[a-z0-9-]`) + git-URL scheme validation; `start`/`stop`/`status` via `systemctl --machine`. Done: start/stop a dummy user unit through the socket. | M | — |
| T08 | **`pm-projectctl create`** — create `pm-<name>` user + subuid ranges, install/enable its rootless docker, generate deploy key (return pubkey), clone repo, scaffold `.pm/` if empty. Done: one call turns a git URL into a running project daemon + runner socket. *Split seam: user+daemon / key+clone.* | L | T07 |
| T09 | **`pm-projectctl delete` + `set-credential`** — remove user (with `--purge` flag for volumes/images); write a secret into `pm-<name>`'s `~/.pm-creds` (0600). Done: delete reverses create; set-credential lands a file readable only by the project user. | M | T08 |
| T10 | **Runner skeleton + control protocol** — Node process run as `pm-<project>`; unix socket; typed request/response for `startRun/stopRun/streamLogs/status/commitAndPush` (handlers stubbed). Done: pm client can call `status` and stream a dummy log. | M | T01 |
| T11 | **pm ↔ runner client + discovery** — scan `/srv/pm/runners/`, track lifecycle state per project, reconnecting client. Done: projects appear/disappear as sockets come/go; state reflected in an API field. | M | T10 |
| T12 | **Fastify API skeleton** — `projects` list/get, `tasks` CRUD, `comments` create; writes staged to the working tree + `commitAndPush` via runner; reads from SQLite cache. Done: create a task via API → file appears in `.pm/` and in the cache. | M | T06, T11 |
| T13 | **React app shell** — routing + header (project selector, Tasks/Specs/ADRs tabs, search box, daemon badge, Settings menu, logout), compact layout + theming per the wireframe. Done: shell renders, navigates, talks to the API; light/dark. | M | T12 |
| T14 | **Task list + task view (static)** — sidebar grouped by status folder (collapsible), task main area with description render/edit toggle. Done: real tasks list and open; description edits persist through the API. | M | T13 |
| T15 | **Description attachments + clipboard** — paste image → stored attachment; large text paste → `pasted-NN.md`; file-upload button; render inline. Done: pasting an image and a big snippet creates files under the task folder and shows them. | M | T14 |

## M2 · Claude implement path (end-to-end)

| ID | Task | Effort | Deps |
|----|------|--------|------|
| T16 | **Provider adapter interface + Claude adapter** — `containerCmd/parseEvents/extractOutcome/extractCost/models`; parse stream-json incl. `total_cost_usd`. Done: unit test feeds a recorded stream-json → outcome + cost extracted. | M | T01 |
| T17 | **Runner: workspace prep** — create `pm/task-<id>-<slug>` from default branch in a per-task workspace volume; reuse on later runs. Done: `startRun` yields a branch + workspace ready for the agent. | M | T10 |
| T18 | **Runner: agent container lifecycle** — launch pm-agent with repo + rootless socket + secrets (ro), run the adapter's command, capture stdout as JSONL, enforce timeout, stop = SIGTERM→SIGKILL. Done: a real Claude run edits a file and commits in the workspace. *Split seam: container launch / stream capture.* | L | T03, T16, T17 |
| T19 | **Run queue + orchestration** (pm) — serial per task, global concurrency limit, per-run timeout, mark `interrupted` on restart; auto-activate a stopped project before running. Done: two queued runs on one task serialize; a run survives an idle project (it starts first). | M | T11, T18 |
| T20 | **Log streaming: runner → pm SSE → UI** — `streamLogs` to `/api/runs/:id/events`, live tail component with stop button. Done: a running agent's output tails live in the browser; stop works. | M | T18, T13 |
| T21 | **Outcome + cost persistence** — write `runs/NNNN.md` (front matter incl. cost/tokens) to `.pm/` on completion; raw JSONL kept in pm data dir with retention. Done: finished run shows outcome md + cost chip; totals survive a cache rebuild. | S | T18, T06 |
| T22 | **`commitAndPush`** (runner) — push the task branch with the deploy key; `.pm/` commits to the pinned default-branch checkout. Done: after a successful run the branch is on `origin`; `.pm/` changes land on default. | S | T18 |
| T23 | **Task view: launch bar + timeline** — phase×provider×model pickers + Run + per-phase quick buttons; unified timeline (status/comment/run entries) with run chips (cost, status), comment composer. Done: launch an implement run from the UI and watch it complete in the timeline. | L | T20, T21, T16 |

## M3 · Verify

| ID | Task | Effort | Deps |
|----|------|--------|------|
| T24 | **Contract detection + compliance** — detect compose file, main service healthcheck, `test`/`e2e` services, `has_ui`; compute compliance state; inject the "make this repo compliant" clause into implement prompts when non-compliant. Done: compliant and empty repos report correct badges. | M | T05 |
| T25 | **Verify runner** — fresh checkout of the pushed branch into a new volume; `docker compose up --wait --build` (unique project name, no host ports); run `test` then `e2e`; teardown. Done: green project passes, a failing test reports failure + logs. *Split seam: up+health / test+e2e.* | L | T22, T24 |
| T26 | **Artifact collection** — `docker cp` `./pm-artifacts` out; video→GIF/webm via ffmpeg; store in pm data dir; copy small final screenshots into the run's attachments. Done: e2e artifacts appear as files pm can serve. | M | T25 |
| T27 | **UI: verify results + artifacts gallery** — pass/fail summary, screenshot thumbnails, GIF/video playback, lightbox; compliance badge in header/project view. Done: a UI project's run ends with viewable visual proof. | M | T26, T23 |
| T28 | **Verify → implement feedback** — auto-run verify after a successful implement; format failures into the next implement prompt. Done: a failing verify's output is present in the following implement run's composed prompt. | S | T25, T19 |

## M4 · Remaining phases + specs/ADRs

| ID | Task | Effort | Deps |
|----|------|--------|------|
| T29 | **Prompt template system** — per-phase plain-text templates + server-side composition embedding description, Q&A, plan, review/verify findings, relevant specs/ADRs; "do not modify files" guard for non-implement phases + workspace reset. Done: each phase produces a correct composed prompt (snapshot tests). | M | T16, T24 |
| T30 | **Interview phase** — prompt for JSON questions, parse to `questions` table, inline answer form; answers feed later phases. Done: an interview run yields a form; answering it persists and appears in the next prompt. | M | T29, T23 |
| T31 | **Refine phase + description versioning** — replace description, keep prior versions in run history. Done: refine updates the description; old version viewable. | S | T29 |
| T32 | **Plan phase** — attach plan markdown to the task; render in timeline. Done: a plan run stores and displays a plan. | S | T29 |
| T33 | **Review phase + acceptance** — review against diff + running env → findings; move task to `ready for review`; **Accept** button → `done`; optional per-project auto-run-review toggle. Done: review produces findings without auto-implementing; Accept closes the task. | M | T29, T25 |
| T34 | **Specs / ADRs tabs** — list + rendered markdown; ADR status chips (accepted/superseded/abandoned, abandoned struck through); per-file git-history link. Done: specs and ADRs from `.pm/` render and navigate. | M | T13, T05 |

## M5 · Lifecycle, providers, cost, Antigravity

| ID | Task | Effort | Deps |
|----|------|--------|------|
| T35 | **Project lifecycle** — idle-timeout deactivation (compose-down leftovers, stop daemon + runner), manual on/off toggle, "always on" pin, `active/idle/stopped` badges. Done: an idle project stops on its own and auto-starts on the next run. | M | T19 |
| T36 | **Provider setup UI** — Settings→Providers: OAuth device-login and API-key entry routed one-way through `pm-projectctl set-credential`; masked status (connected/account/expiry); choose launch-bar models; per-project defaults. Done: connecting a provider makes it usable in runs; pm stores only masked status. | L | T09, T16, T13 |
| T37 | **Cost roll-ups** — task/project/MTD aggregation queries + UI (task header, project view, header MTD). Done: totals match the sum of run costs and update after a run. | S | T21 |
| T38 | **Antigravity adapter** — verify `agy` unattended flags on the VPS; implement the adapter behind the same interface. Done: an implement run completes with provider = antigravity. | M | T16 |

## M6 · Deployment

| ID | Task | Effort | Deps |
|----|------|--------|------|
| T39 | **`roles/pm` — base** — create `pm` user + rootless dockerd (generalize `docker_rootless.yml`), `pm` group, `/srv/pm/{runners,...}`, sysctl `ip_unprivileged_port_start=443`, build images, bring the compose stack up via a systemd user unit. Done: playbook run leaves the pm stack listening. | L | T02 |
| T40 | **`roles/pm` — nginx + TLS + auth** — render nginx conf, self-signed origin cert into a volume, htpasswd from vaulted `pm_auth_password`; document Cloudflare Full(strict). Done: origin serves TLS + basic auth ready for Cloudflare. | S | T39 |
| T41 | **`roles/pm` — pm-projectctl install** — deploy the helper + its systemd unit and socket permissions; no provider creds in Ansible. Done: `create/start/stop/delete` reachable from the pm container after a playbook run. | S | T39, T08 |
| T42 | **`roles/nftables` — 443** — add the accept rule (no port 80 — Cloudflare Full-strict always connects over HTTPS), optionally scoped to Cloudflare IP ranges. Done: origin reachable only as intended. | S | — |
| T43 | **End-to-end smoke + runbook** — on the VPS: add a project from the UI, run implement→verify on a tiny sample repo, confirm branch + artifacts; write `docs/pm-runbook.md`. Done: documented green path start to finish. | M | T39–T42, T27 |

---

## Summary

| Effort | Count | Task IDs |
|--------|-------|----------|
| S | 11 | T01, T03, T21, T22, T28, T31, T32, T37, T40, T41, T42 |
| M | 26 | T02, T04, T05, T06, T07, T09, T10, T11, T12, T13, T14, T15, T16, T17, T19, T20, T24, T26, T27, T29, T30, T33, T34, T35, T38, T43 |
| L | 6 | T08, T18, T23, T25, T36, T39 |

Total: **43 tasks**.

**Critical path** (thinnest end-to-end slice, the "small bugfix" flow):
T01 → T02 → T04/T05/T06 → T07/T08 → T10/T11 → T12 → T13/T14 →
T16/T17 → T18 → T19/T20/T21/T22 → T23. Everything after M2 layers onto this.

**Parallelizable early:** T03 (agent image), T07/T08 (host helper), and
T04/T05 (data layer) have no cross-deps and can be three simultaneous sessions.

The six **L** tasks are the ones to watch: each names a split seam, so if one
overruns a single session it becomes two S/M tasks rather than a stuck run.
