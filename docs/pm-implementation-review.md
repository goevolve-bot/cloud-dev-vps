# PM System — Implementation Review

Review of branch `app` (commits `e174362`…`72ccac1`, "M2 impl" … "M6 impl")
against `docs/pm-system-plan.md` and `docs/pm-task-breakdown.md`.

**Method.** Full read of `app/` (core, server, runner, web, scripts, compose,
agent image) and `roles/pm` + `roles/nftables`; ran `pnpm -r typecheck`,
`pnpm -r test`, `pnpm lint`, and `python3 -m unittest discover -s scripts`.
Nothing was executed against a real VPS, so runtime claims below are derived
from the code and are marked where they need on-host confirmation.

---

## 1. Verdict

The **skeleton is real and the low-level pieces are good**: `pm-projectctl`
(1 517 lines of dependency-free Python) is genuinely well built — argv-only
execution, resumable `create`, per-project locks, correct home/permission
layout — and the `core/` `.pm` model library, the SQLite cache + indexer, and
the runner control protocol + reconnecting client are clean, tested code.

But the system **cannot currently run end to end**, and the gap is not a
matter of polish. Three independent blockers each stop the "small bugfix"
critical path on their own:

1. **No project can be created.** Nothing in the server ever inserts into the
   `projects` table and there is no `POST /api/projects`; the add-project modal
   described in the plan (and in `docs/pm-runbook.md`) does not exist in the UI.
   `pm-projectctl create` is reachable only from an SSH shell.
2. **The web UI is never served.** The pm image doesn't build `web/`, the server
   registers no static handler, and nginx proxies `/` straight to `pm:3000`.
   The deployed stack serves the JSON API and nothing else.
3. **The pm container has no volumes at all.** No `/srv/pm/runners`, no
   `/srv/pm/projectctl.sock`, no project homes, no data dir. pm therefore cannot
   see a runner socket, cannot reach projectctl, cannot read or write any
   project's `.pm/` tree, and loses its SQLite DB on every container recreate.

On top of that, provider credentials never actually reach a project user (the
`set-credential` call is malformed in three separate ways, §3.4), and the
implement prompt never tells the agent to commit while the runner only ever
pushes — so even with the above fixed, an implement run would deliver an empty
branch.

Milestones M3–M6 were committed as if complete, but M3 (verify) and M6
(deploy) contain untested assumptions that look likely to fail on first
contact, and T43's "documented green path" was clearly never walked: the
runbook instructs the user to click buttons that do not exist.

**Rough state**: M0/M1 largely real (minus the add-project flow), M2 wired but
undeliverable, M3 plausible-looking but unproven, M4 functional in outline,
M5 partly stubbed, M6 written but not run.

---

## 2. Milestone-by-milestone status

| ID | Task | State | Notes |
|----|------|-------|-------|
| T01 | monorepo scaffold | ✅ | typecheck passes on all 4 packages |
| T02 | compose stack | ⚠️ | builds, but pm service has **no volumes**, no SPA, no data persistence (§3.3) |
| T03 | pm-agent image | ✅ | matches the plan (no toolchains, rg/fd/jq/fzf/bat/delta) |
| T04 | SQLite + migrations | ✅ | migrate up/down + tests |
| T05 | `.pm/` model library | ✅ | good round-trip tests |
| T06 | indexer | ✅ | full rebuild + incremental, tested |
| T07 | projectctl core | ✅ | strong |
| T08 | projectctl create | ✅ (helper) / ❌ (UI) | helper is resumable & idempotent; **no API/UI caller** (§3.1) |
| T09 | delete + set-credential | ✅ (helper) / ❌ (caller) | server calls it with wrong verb args (§3.4) |
| T10 | runner skeleton | ✅ | protocol is clean |
| T11 | pm ↔ runner discovery | ✅ | good tests |
| T12 | Fastify API | ⚠️ | tasks/comments work; no projects endpoint, no search |
| T13 | React shell | ⚠️ | renders; search box, logout, daemon toggle, "+ add project" are inert |
| T14 | task list + view | ✅ | |
| T15 | attachments/clipboard | ✅ | |
| T16 | adapter + Claude | ⚠️ | works, but stale model IDs and no `models()` wiring (§4.3) |
| T17 | workspace prep | ⚠️ | worktree-based, reasonable; `PM_REPO_DIR` ignored (§3.7) |
| T18 | agent container lifecycle | ⚠️ | runs, but secrets via `-e` on argv (§5.1), colliding run IDs (§3.6) |
| T19 | queue | ⚠️ | double-start race, queued runs stranded after restart (§3.8) |
| T20 | log streaming/SSE | ⚠️ | works; lossy fire-and-forget log writes (§4.6) |
| T21 | outcome + cost | ✅ | writes `runs/NNNN.md` with cost front matter |
| T22 | commitAndPush | ❌ | **never commits** the agent's work (§3.5) |
| T23 | launch bar + timeline | ⚠️ | present; run correlation is a heuristic, no status entries, no verify phase |
| T24 | contract detection | ⚠️ | "main service" = service named after the project (§4.1) |
| T25 | verify runner | ⚠️ | `up --wait` will also start `test`/`e2e` (§3.9); verifies local clone, not origin |
| T26 | artifact collection | ⚠️ | works in principle; artifacts land in the repo tree, not pm's data dir |
| T27 | artifacts gallery | ⚠️ | renders; artifact route has a path traversal (§5.2) |
| T28 | verify → implement feedback | ✅ | auto-verify after implement, findings folded into next prompt |
| T29 | prompt templates | ⚠️ | composition is good; review diff runs git **inside the pm container** (§3.10) |
| T30 | interview | ✅ | JSON parse + inline answer form |
| T31 | refine | ⚠️ | replaces description; no version viewer |
| T32 | plan | ✅ | |
| T33 | review + accept | ⚠️ | Accept works; review is not a fresh checkout and no env is started (§4.4) |
| T34 | specs/ADRs tabs | ✅ | |
| T35 | lifecycle | ⚠️ | idle timeout 30 min (plan says 15); no compose-down of leftovers; badge not clickable |
| T36 | provider setup | ❌ | credential write is broken end-to-end (§3.4); OAuth not implemented, only API keys |
| T37 | cost roll-ups | ⚠️ | sums the runtime `runs` table, so totals do **not** survive a cache rebuild |
| T38 | antigravity adapter | ⚠️ | copy of the Claude adapter; flags never verified against `agy --help` as the task required |
| T39–T42 | Ansible | ⚠️ | written, never run; htpasswd never reaches nginx (§5.3), no volumes (§3.3) |
| T43 | smoke + runbook | ❌ | runbook documents a UI that does not exist |

---

## 3. Blocking defects

### 3.1 No way to create a project
`app/server/src/app.ts` has no `POST /api/projects`; `grep` finds zero
`INSERT INTO projects` anywhere in the codebase. `RunnerRegistry` discovers
sockets under `/srv/pm/runners/` but never reconciles them into the DB, and
every task/comment/run route starts with `getProjectRow(name)` → 404. The
header's project `<select>` (`web/src/components/Header.tsx:62`) has no
"+ add project…" entry, so the two-step deploy-key modal from the plan is
absent. Result: a fresh deploy shows "No projects yet." forever.

### 3.2 The SPA is never served
`app/server/Dockerfile` copies only `core` and `server`; `app.ts` registers no
`@fastify/static`; `nginx/nginx.conf` proxies `location /` to `pm:3000`. The
built `web/dist` exists only as a local artifact. Browsing to the origin
returns Fastify's 404 JSON.

### 3.3 The pm container is mounted into nothing
`app/compose.yaml` `pm:` declares `build`, `restart`, `expose`, `environment` —
and no `volumes`. Consequences:

- `PM_RUNNERS_DIR` (`/srv/pm/runners`) is empty inside the container → every
  project reads as `disconnected`, `runners.client()` always `undefined`.
- `callProjectctl` connects to `/srv/pm/projectctl.sock`, which does not exist
  inside the container → every lifecycle/credential call returns
  `connection_error`.
- `project.repo_dir` points at `/home/pm-<name>/work/<repo>` on the host; the
  container cannot see it, so `createTask`/`addComment`/`addRunOutcome` all
  fail (`ENOENT`) even though the on-host permission model (`.pm/` 2770
  `pm-<name>:pm`) was carefully built to make them work.
- `PM_DB_PATH` defaults to `/var/lib/pm/pm.sqlite3` **inside the image** →
  the database and all runtime run history are lost on every recreate.
- `PM_DATA_DIR` is never set, so JSONL logs and copied artifacts land in the
  container's `/repo/server` (`queue.ts:254`, `queue.ts:327`). Ansible creates
  `/srv/pm/data` and `/srv/pm/data/runs` and then never uses them.

### 3.4 Provider credentials never reach a project user
`app.ts:711` calls:

```ts
callProjectctl("set-credential", { name: "_pm", credential: credName, value: body.key })
```

Three mismatches against `scripts/pm-projectctl:1168`:
1. the helper reads `args["key"]`, not `args["credential"]` → `invalid_key`;
2. `_pm` fails `NAME_RE` (`^[a-z0-9](?:[a-z0-9-]{0,27}[a-z0-9])?$`) → `invalid_name`;
   and even if it passed, `_require_existing` would reject it (no such user);
3. the key name sent is `ANTHROPIC_API_KEY`, which fails
   `CREDENTIAL_KEY_RE` (`^[a-z][a-z0-9_-]{0,63}$`).

The masked row is still written to `provider_creds` and the UI reports
"Connected", so the failure is silent. `~/.pm-creds/` stays empty for every
project, the runner's credential loop (`handlers.ts:613`) finds nothing, and
the agent container starts with no API key. There is also no re-seeding of
credentials on `create`, which the plan calls for, and no OAuth flow at all
(the UI offers API keys only, while `/api/providers` advertises
`authType: "oauth"` for antigravity — a contradiction).

### 3.5 Implement runs deliver nothing
`runner/src/handlers.ts:705` `commitAndPush` with a branch does exactly one
thing: `git push origin <branch>` from the task worktree. It never stages or
commits. `server/prompts/implement.txt` never instructs the agent to commit
either — it ends at *"You should modify the files to implement the features
described in the description and plan."* So an implement run leaves dirty,
uncommitted files in the worktree, pushes an unchanged branch, reports
success, and auto-triggers verify — which clones the repo and sees none of the
work. (The plan's step 2 assumes "the agent commits in the workspace"; that
instruction was never written into the prompt.)

Worse, the next non-implement run on that task resets the worktree
(`handlers.ts:684-689`), silently destroying the uncommitted work.

### 3.6 Runner run IDs collide across tasks
`handlers.ts:538-541` derives the run id from the count of `runs/*.md` files
**inside one task folder**, so two different tasks both produce run `1`. That id
is then used for a global log path (`~/logs/1.log`, `handlers.ts:53`) and a
global container name (`pm-agent-run-1`, `handlers.ts:598`). With the global
concurrency limit of 2, two concurrent runs on different tasks will interleave
their logs into one file and the second `docker run` will fail with a name
conflict. pm's own `runs.id` (a proper autoincrement) is never sent to the
runner; the mapping lives only in an in-memory `Map`
(`queue.ts:62 activeRunnerRunIds`), so after a pm restart no in-flight run can
be stopped or streamed.

Also note `handlers.ts:489-525`: 37 lines of the generating agent's
stream-of-consciousness ("Wait! Let's check…") were committed verbatim into the
production `startRun` handler.

### 3.7 The runner ignores the environment projectctl gives it
`render_runner_unit` exports `PM_REPO_DIR`, `PM_CREDS_DIR` and `PM_DEPLOY_KEY`
(`scripts/pm-projectctl:918-923`). The runner reads none of them. Instead
`findRepoDir()` (`handlers.ts:78`) lists `~/work` and returns the first entry
not starting with `task-`. Verify workspaces are named `verify-<task>-<run>`
and live in the same directory, so while a verify is in flight `findRepoDir()`
can return the temporary verify checkout as "the repo" — and that path is then
used for `.pm/` writes and `commitAndPush`.

### 3.8 Queue races
`queue.ts:180` fires `void this.executeRun(run)` and loops after 10 ms. When
the project's runner is not connected, `executeRun` awaits
`callProjectctl("start", …)` **before** flipping the row to `running`
(`queue.ts:199` vs `queue.ts:217`), so the loop re-reads the same still-`queued`
row and starts it a second time. Separately, `init()` only marks `running` →
`interrupted`; it never calls `trigger()`, so runs that were `queued` at
shutdown sit forever until someone posts a new run.

### 3.9 Verify starts the one-shot services it is supposed to run separately
`handlers.ts:346` runs `docker compose up --wait --build` over the *whole*
compose file, then runs `test` and `e2e` via `compose run`. Nothing excludes
the one-shot services from the `up` (no profiles, no `--scale test=0`), so
`--wait` will also wait on containers that exit immediately — which Compose
reports as a startup failure. On the plan's own reference project shape
(main service + `test` + `e2e`) verify looks likely to fail before it runs a
single test. **Needs confirmation on the VPS**, but the code as written does
not match the contract it is enforcing.

Related, smaller verify issues:
- It clones the **local** repo (`git clone repoDir`), not `origin`, so it does
  not verify what was pushed (plan §Git flow step 5).
- The verify run is never registered in `activeRuns` (`handlers.ts:546`), so
  `stopRun` cannot cancel it and `streamLogs` immediately returns
  `complete: true` — the live tail for verify is dead on arrival.
- `executeVerify` is launched with `void` and has no timeout; a hung
  `compose up --build` blocks the run forever (the 30-minute timeout only
  applies to agent containers, `handlers.ts:650`).
- Teardown runs `docker compose -p <name> down -v` without `-f`, from the
  runner's cwd — with the verify directory already about to be deleted this is
  fragile; leftover volumes are plausible.

### 3.10 Review diff is computed in the wrong process (and without git)
`server/src/prompts.ts:78-87` shells out to `git diff main...pm/task-N-slug`
with `cwd: repoDir` — from inside the pm container. That violates the plan's
"pm never runs git for a project", it cannot work without the repo mounted
(§3.3), and the pm image is `node:22-alpine` with no `git` installed at all.
The failure is swallowed into the prompt text: every review run will be handed
`Could not generate git diff: …` as its diff.

---

## 4. Correctness issues (non-blocking but wrong)

**4.1 Contract detection keys off the project name.**
`core/src/pm/contract.ts:60` treats the service named exactly like the project
as "the main service", and `isCompliant` is `mainServiceExists &&
mainServiceHasHealthcheck`. The plan says only *"the main service must define a
healthcheck"* — a repo whose compose service is `app` or `web` can never be
compliant, so its implement prompts carry the "make this repo compliant" clause
forever. `Dockerfile` presence is never checked despite being contract item 1.

**4.2 `task.branch` is never set.** `setTaskBranch` exists in `core` and has
zero callers, so the front-matter `branch` field stays `null` and the branch
chip in the task header never renders — even though the runner does create
`pm/task-<id>-<slug>`.

**4.3 Model lists are hardcoded, stale, and duplicated in four places.**
`core/.../claude.ts:53`, `/api/providers` (`app.ts:660`), `SettingsModal.tsx:31`
and `TaskView.tsx:568` each carry their own copy of
`claude-3-5-sonnet-latest` / `claude-3-opus-latest`. The adapter's `models()`
is never called by the API, contrary to the plan ("choose which models
populate the launch-bar dropdowns (from each adapter's `models()`)"). All the
listed Claude IDs are two generations behind the current Claude 5 family, so a
default run would target an outdated model.

**4.4 Review phase doesn't match its spec.** The plan wants a *fresh checkout*
with the *project env started* so the agent can poke the running app. The
implementation reuses the existing task worktree and starts nothing.

**4.5 No automatic status transitions.** The plan's flow is
implement → verify → `ready for review`. In practice only a *review* run moves
a task (`queue.ts:313`), nothing ever moves a task to `in-progress`, and verify
never lands it in `ready-for-review`. The board therefore doesn't reflect
reality unless the user drives the status dropdown by hand.

**4.6 Log writes are fire-and-forget.** `handlers.ts:140`/`661` call
`void logManager.appendLine(...)` per line with no serialization; concurrent
`appendFile` calls can interleave and the emitter's `end` can fire before the
last append lands. This is not theoretical — `runner/src/socket-server.test.ts`
("startRun, streamLogs, stopRun, and commitAndPush work end-to-end") **fails**
when the suite runs under load (`pnpm -r test`) and passes when run alone; I
reproduced both.

**4.7 Run success is inferred only from a JSON `result` event**
(`queue.ts:280`). The container's exit code is never reported back by the
runner, so a crashed agent that emitted no JSON and a successful agent with a
different output shape are both recorded as `failed`, with `exit_code` a
synthetic `0`/`1`.

**4.8 Timeline correlation is a heuristic.** `TaskView.tsx:708` matches a
repo-side run to a runtime run by `(phase, started_at)` string equality; two
runs of the same phase starting in the same millisecond, or a null
`started_at`, mis-associate the questions/live-log block.

**4.9 Cost totals don't survive a cache rebuild.** `/api/costs/*`
(`app.ts:583-613`) aggregate the runtime `runs` table, not `task_runs` (which
is what's rebuilt from `.pm/`). The plan explicitly requires the opposite.

**4.10 Duplicate artifact copies.** `queue.ts:324-341` copies verify artifacts
into `PM_DATA_DIR/artifacts/<run.id>` and records `artifacts_dir`, but the
serving route reads from the repo's `.pm/verify-artifacts/<runnerRunId>/`
instead. The data-dir copy is dead weight.

**4.11 Idle timeout is 30 min, plan says 15**, is not per-project configurable,
and the "compose down leftover verification environments" step from the plan is
not implemented. The `active/idle/stopped` badge is display-only — start/stop
lives buried in the settings modal, and there's no `idle` state ever written.

**4.12 Inert UI affordances.** Header search (`Header.tsx:85`) has no handler
and there is no search API; the logout button does nothing; the daemon badge
isn't clickable; there's no "always on" pin in the header; verify is missing
from the phase dropdown so it can't be re-run manually as the plan requires;
timeline shows no status-change entries.

---

## 5. Security findings

**5.1 Provider credentials are passed as `docker run -e KEY=value`**
(`handlers.ts:619-622`). Process arguments are world-readable in `/proc`, so
any user on the host can read the token out of the docker CLI's argv while a
run is in flight — this partially undoes the isolation model the rest of the
system works hard to maintain. The loop is also indiscriminate: for every file
in `~/.pm-creds` it exports `<FILENAME>_API_KEY` **and** `<FILENAME>_TOKEN`,
plus `ANTHROPIC_API_KEY` for three special names. Mounting the creds directory
read-only (as the plan describes) avoids this entirely.

**5.2 Path traversal in the artifacts routes.** `app.ts:538` and `app.ts:558`
interpolate `runNum` straight into `join(repoPmDir, "verify-artifacts", runNum)`
with no validation, while only `filename` is checked by `isSafeFilename`. A
request with `runNum` = `../../..` reads and lists arbitrary paths reachable by
the pm user. Behind basic auth, but a trivial fix (`/^\d+$/`).

**5.3 The Ansible htpasswd never reaches nginx.**
`roles/pm/tasks/nginx_tls.yml` writes the generated file to
`{{ pm_app_dest }}/auth/htpasswd`, but `compose.yaml` mounts the **named
volume** `auth:` into nginx and populates it from `auth-init`, whose defaults
are `admin` / `changeme`. A production deploy therefore ends up with the
hardcoded dev password protecting the UI, and the vaulted one unused.
Compounding this, `group_vars/all.yml` currently ships
`pm_auth_password: changeme` in plaintext.

**5.4 `sysctl ip_unprivileged_port_start=80`** (`roles/pm/defaults/main.yml`)
opens all ports ≥ 80 to unprivileged binds. The plan specifies 443, and there
is deliberately no :80 listener. (The task breakdown says 80 — the two docs
disagree; 443 is the tighter and stated-elsewhere intent.)

**5.5 Prompt-injection surface is unmitigated.** Task descriptions, comments,
specs and ADRs are interpolated into prompts (`prompts.ts:110-118`) with no
delimiting, and implement runs execute with `--dangerously-skip-permissions`
and the deploy key mounted. That's inherent to the design's trust model, but
worth an explicit note since anything that can write `.pm/` can steer an agent
that holds push rights.

**5.6 Minor:** `/api/questions/:id/answer` (`app.ts:224`) is not scoped to a
project or task — any question id is answerable by id alone.

---

## 6. Deviations from the plan worth a decision

| Plan says | Implementation does |
|---|---|
| Raw logs and verify videos live in **pm's data dir** with retention | Artifacts are written into the repo working tree (`.pm/verify-artifacts/`, self-ignored via a `*` gitignore) and served from there; no retention anywhere |
| Costs live in the run's `.pm/` file so totals survive a cache rebuild | Totals are summed from the runtime `runs` table |
| pm never runs git for a project | pm runs `git diff` for the review prompt (§3.10) |
| Verify checks out **the pushed branch** into a fresh volume | Clones the local working repo |
| Per-run timeout default 30 min, configurable; global concurrency default 2 | Both hardcoded (`handlers.ts:650`, `queue.ts:149`); verify has no timeout at all |
| Idle timeout default 15 min, configurable per project | Hardcoded 30 min, global env var only |
| Provider credentials re-seeded into each new project user on `create` | Never happens (and §3.4) |
| Antigravity flags "to be verified via `agy --help` on the VPS" (T38's whole point) | Adapter assumes `agy` accepts Claude Code's exact flag set, including `--dangerously-skip-permissions` and `--output-format stream-json` |

---

## 7. Code quality / process

- `pnpm -r typecheck` — **passes** (4/4 packages).
- `pnpm lint` — **fails, 42 errors** (mostly `no-explicit-any` in
  `server/src/queue.ts` and `app.ts`, one `prefer-const`). Lint is evidently
  not part of anyone's loop.
- Tests: core 22 ✅, server 35 ✅, runner 3/4 (one load-dependent failure,
  §4.6), projectctl 49 ✅ (12 skipped — the root-requiring ones).
- **Coverage gaps line up exactly with the defect list**: no tests for
  `queue.ts` (the race, the auto-verify chain), none for `executeVerify`,
  none for `startRun`'s docker argv, none for the provider routes, none for the
  web layer. The three subsystems with no tests are the three that don't work.
- The commit granularity ("M2 impl", "M3 impl", …) makes per-task review
  impossible; T24 and T25 are indistinguishable in history.
- `app/server/prompts/` is copied into the image but resolved via
  `import.meta.dirname/../prompts` — correct for the built layout, worth a test.

---

## 8. Suggested remediation order

**Unblock the critical path (nothing else matters until these land):**

1. Mount reality into the pm container: `/srv/pm/runners` (ro),
   `/srv/pm/projectctl.sock`, `/srv/pm/data` (rw, as `PM_DATA_DIR` and
   `PM_DB_PATH`), and each project's `~/work` tree — plus a `pm` group gid on
   the container so the `.pm/` 2770 permissions actually apply.
2. Serve the SPA: build `web/` in the server Dockerfile, add
   `@fastify/static` with an SPA fallback.
3. Add `POST /api/projects` → `pm-projectctl create` (streaming progress,
   handling `awaiting-key`), insert the row, run `rebuildIndex`; wire the
   two-step add-project modal into the header.
4. Fix `set-credential`: correct arg name, lowercase key, real per-project fan-out
   (write to every project user, and on `create`), and switch the agent from
   `-e` to a read-only mount of `~/.pm-creds`.
5. Make implement deliver: add explicit commit instructions to
   `implement.txt` **and** have `commitAndPush` stage + commit any residual
   changes before pushing; set `task.branch` via `setTaskBranch`.
6. Have pm own the run id: pass `runId` in `StartRunArgs`, use it for log paths
   and container names, and persist it on the row so restarts don't strand runs.

**Then correctness:**

7. Exclude `test`/`e2e` from `compose up --wait` (profiles or explicit service
   list) and validate the whole verify path against a real sample repo.
8. Register verify runs in `activeRuns`, give them a timeout, and stream them.
9. Fix the queue double-start (flip to `running` before any await) and trigger
   the queue on boot.
10. Validate `runNum` in the artifact routes; move the review diff to a runner
    verb; serialize log appends.
11. Fix the Ansible htpasswd path, vault the password, drop
    `ip_unprivileged_port_start` to 443.
12. Refresh model lists from `adapter.models()` and update the IDs to current
    models; actually verify `agy`'s unattended flags on the VPS.
13. Clear the lint backlog and delete the stray reasoning comments in
    `handlers.ts:489-525`.

**Then honesty:** rewrite `docs/pm-runbook.md` after the green path has really
been walked once — it is currently a description of an intended system, not the
built one.

---

## 9. What's genuinely good

Worth preserving as-is: `pm-projectctl` (the security-critical component is the
best-written thing in the branch — validation, argv-only exec, resumability,
locking, and a real test suite); the `.pm/` model library and its round-trip
tests; the indexer's rebuild/incremental split; the runner protocol and the
reconnecting client with its backoff and pending-call semantics; the nginx
Cloudflare real-IP configuration and its rationale comments; the agent image
(faithful to the "no toolchains" rule). The isolation model survives contact
with the implementation in the places where it was actually implemented — the
gaps are wiring and delivery, not architecture.
