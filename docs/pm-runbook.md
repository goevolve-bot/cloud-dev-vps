# PM System — Deployment Runbook

> Rewritten 2026-07-25 from an actual deployment onto a bare VPS
> (Debian 13 trixie, 2 vCPU / 4 GB / 38 GB). Everything below was executed; the
> "What is still unproven" section at the end says plainly what was not.
>
> The previous version of this file described a green path that had never been
> walked — it told you to click buttons that did not exist. Six playbook runs
> were needed to get from a bare host to a passing verify. What broke, and why,
> is recorded in §7 rather than quietly fixed, because every one of those
> failures is a thing a future deploy can hit again.
>
> A second pass the same day added the provider credential and ran the agent
> phases — interview, plan, implement, review — plus the public Cloudflare
> path. That took six more failures, in §7b. The first pass had confirmed
> everything *downstream* of the agent container; it turned out the container
> itself could not start, could not use git, and could not write the one field
> it was supposed to set.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| Ansible ≥ 2.14 on the control node | `uv tool install --with ansible ansible-core` — installing the `ansible` bundle alone gives you an `ansible-community` binary and no `ansible-playbook` |
| `rsync` on control node **and** target | `roles/pm` deploys the app tree with `synchronize` |
| VPS running Debian 12 or 13 | Root SSH key access. Verified on 13 (trixie) |
| A git repository to manage | Must accept a deploy key with **write** access |
| A provider credential | Claude Code OAuth token (`claude setup-token`) or an Anthropic console API key. Needed only for agent phases — see §6 |
| Domain proxied through Cloudflare | Optional but assumed by the firewall — see §3 |

---

## 2. Initial provisioning

### 2.1 Clone the ops repo

```bash
git clone git@github.com:titarenko/cloud-dev-vps.git
cd cloud-dev-vps
```

### 2.2 Set the web password

`pm_auth_password` has no default anywhere in the repo and `roles/pm` asserts it
is set, so the play fails loudly rather than deploying a password that lives in
git history.

```bash
echo 'your-vault-password' > ~/.pm-vault-pass
chmod 600 ~/.pm-vault-pass

ansible-vault encrypt_string 'your-web-password' \
  --name pm_auth_password \
  --vault-password-file ~/.pm-vault-pass
```

Paste the output into `group_vars/all.yml` beneath `pm_auth_user`.

### 2.3 Set your inventory

```ini
[vps]
your-vps-ip-or-hostname
```

### 2.4 Run the playbook

```bash
ansible-playbook playbook.yml \
  --vault-password-file ~/.pm-vault-pass \
  -u root
```

Roughly 3.5 minutes on a cold host, most of it the `apt full-upgrade`, the
`pm-agent` image build, and the pm server image build. Expected:

```
PLAY RECAP ******************************************************************
your-vps : ok=119  changed=14  unreachable=0  failed=0
```

### 2.5 Confirm the stack is actually up

`failed=0` is not sufficient — the stack can deploy cleanly and crash-loop (it
did; §7.5). Check the containers, not just the play:

```bash
ssh root@your-vps
runuser -u pm -- env XDG_RUNTIME_DIR=/run/user/$(id -u pm) \
  DOCKER_HOST=unix:///run/user/$(id -u pm)/docker.sock \
  /home/pm/bin/docker ps
```

Both `pm-pm-1` and `pm-nginx-1` must read `Up`. `Restarting` means the server is
crash-looping — get the reason with `docker logs pm-pm-1`.

Then, from the host itself (the firewall blocks :443 from anywhere but
Cloudflare, but `iif lo accept` comes first, so loopback works):

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/            # 401
curl -sk -u pm:PASSWORD -o /dev/null -w '%{http_code}\n' https://127.0.0.1/  # 200
curl -sk -u pm:PASSWORD https://127.0.0.1/api/projects                  # {"projects":[]}
systemctl is-active pm-projectctl.socket                                # active
systemctl --machine pm@.host --user is-active pm-compose.service        # active
nft list ruleset | grep 'dport 443'                                     # cloudflare4/6 rules
```

---

## 3. Cloudflare configuration

1. Set SSL/TLS mode to **Full (strict)**.
2. Point the domain's A/AAAA record at the VPS with the proxy **enabled**.
3. The origin serves a self-signed cert; Cloudflare presents the real one.

> `roles/nftables` accepts :443 **only** from Cloudflare's published ranges, so
> until DNS exists the UI is reachable only over loopback on the host. For
> temporary direct access set `pm_nftables_cloudflare_only: false` in
> `group_vars/all.yml` and re-run. Remember to set it back.

---

## 4. Adding a project

The repository must satisfy the project contract before verify can do anything
useful: a `Dockerfile` at the root, and a `compose.yaml` with a service that
publishes ports **and** declares a `healthcheck`, plus one-shot `test` and
(optionally) `e2e` services. `app/../docs/pm-system-plan.md` has the full rules;
`contract.isCompliant` in the API response tells you whether it passed.

1. Open the UI, log in as **pm**.
2. **+ New project** → name (`[a-z0-9-]`, max 29 chars) and the SSH git URL.
3. Creation stops at `awaiting-key` and shows a public key. **This is expected,
   not a failure.** Add it to the repository as a deploy key **with write
   access** — the runner pushes branches.
4. Click Create again with the same name and URL. The second call resumes: it
   clones, loads the agent image into the project's own Docker daemon,
   scaffolds `.pm/`, and installs the runner unit.
5. The project reads `connected` once its runner socket appears.

The equivalent over the API, which is what was actually used to validate this:

```bash
curl -sk -N -u pm:PASSWORD -H 'Content-Type: application/json' \
  -d '{"name":"smoke","gitUrl":"git@github.com:you/your-repo.git"}' \
  https://127.0.0.1/api/projects
```

It is a Server-Sent Events stream; each provisioning step arrives as its own
`data:` line, ending in `awaiting-key` or `ready`.

---

## 5. Running a task

### 5.1 Create the task

```bash
curl -sk -u pm:PASSWORD -H 'Content-Type: application/json' \
  -d '{"title":"Add a version endpoint","description":"..."}' \
  https://127.0.0.1/api/projects/smoke/tasks
```

The response carries `"pushed":true` when the `.pm/` tree reached `origin` — the
task board is versioned with the code, so a task is a commit.

### 5.2 Implement, then verify

Launch an implement run from the task view (phase, provider, model). The agent
commits in its worktree and the runner pushes `pm/task-<id>-<slug>`; verify is
queued automatically on success.

Verify then, in the project user's own rootless daemon:

1. Clones the **pushed branch from origin** — not the local worktree, so it
   checks what was actually delivered.
2. Rewrites the compose file without host port bindings and brings up only the
   long-running services with `--wait`. Naming them explicitly is what keeps
   `--wait` from blocking forever on `test`/`e2e`, which exit immediately and
   which Compose otherwise reports as a failed start.
3. Runs `test`, then `e2e`.
4. Collects `/pm-artifacts` out of the e2e container, converts videos to GIF,
   and copies screenshots into the task's attachments.
5. Tears the stack down with an explicit `-f` and deletes the workspace.

A passing verify moves the task to `ready-for-review` on its own.

Observed on the reference repo: run completes in ~30 s, `exit_code: 0`, task at
`ready-for-review`, `{"artifacts":["e2e-result.txt"]}`, and no leftover
containers, volumes or `verify-*` work directories.

---

## 6. Provider credentials

Credentials are set from the UI's settings modal and delivered by
`pm-projectctl set-credential` into `~/.pm-creds/<provider>` on the project
user, mounted read-only into the agent container. They are never in Ansible,
never on argv, and never in the database in plaintext.

**Claude.** Paste either kind of credential; the shim picks the variable from
the value's own prefix, because the CLI reads them from different places:

| Value | Exported as |
|---|---|
| `sk-ant-oat…` (from `claude setup-token`) | `CLAUDE_CODE_OAUTH_TOKEN` |
| anything else (console API key) | `ANTHROPIC_API_KEY` |

Getting this wrong does not fail loudly — an OAuth token exported as
`ANTHROPIC_API_KEY` 401s on every call. The `sk-ant-oat…` branch is the one
that has been exercised on the host; the console-key branch has not.

Setting a credential seeds it into every existing project user and into any
project created later, so `{"ok":true,…,"projectsUpdated":N}` should name every
project you have. Confirm it landed with
`ls -l /home/pm-<name>/.pm-creds/` — `0600`, owned by the project user.

**Antigravity.** There is no API key. `agy` authenticates from a JSON OAuth
document that it writes during an interactive Google login, so the value to
paste is the **contents of that file**, taken from a machine where you have
already logged in:

```bash
cat ~/.gemini/antigravity-cli/antigravity-oauth-token
```

The shim writes it to
`/root/.gemini/antigravity-cli/antigravity-oauth-token` inside the container.
It is copied rather than symlinked because `agy` rewrites the file when it
refreshes the access token, and the credential mount is read-only.

---

## 7. What actually broke on first deploy

Kept because each of these was invisible until a real host ran the code, and
each would recur on a fresh deploy of the pre-2026-07-25 tree.

**7.1 Corepack ignored the pinned pnpm.** `roles/pm` ran
`corepack prepare pnpm@10.11.0 --activate`, but Corepack's shim always prefers
the project's own `packageManager` field and, finding none, resolved the latest
release and tried to *write the field back* into `/srv/pm/app/package.json`.
That runs as `pm` against a root-synced tree, so the runner install died with
`EACCES`. Fixed by adding `packageManager` to `app/package.json`, which also
pins the pnpm used inside `server/Dockerfile`.

**7.2 rsync shipped the wrong ownership.** `synchronize` runs rsync in archive
mode, which preserves *numeric* uid/gid from the control node — the whole
`/srv/pm/app` tree, and the directory itself, landed owned by the control
node's user rather than `pm`. Fixed with `--chown` in `rsync_opts` plus a mode
re-assert, rather than a recursive chown that would walk `node_modules`.

**7.3 No Docker existed for project users.** Every Docker install in the repo
was per-user into `~/bin`, but `pm-<name>` users are created later, by
`pm-projectctl`, which preflights `dockerd-rootless-setuptool.sh` and then
shells out to `docker`. Neither was on any PATH, so no project could be
created. `roles/pm/tasks/docker_host.yml` now installs the static client,
rootless extras, and the compose/buildx plugins system-wide — static tarballs
rather than Docker's apt repo, because `docker-ce-rootless-extras` depends on
`docker-ce` and would install a rootful daemon.

**7.4 The agent image was never built.** `app/agent-image/Dockerfile` had been
in the tree for milestones, but nothing built it — not compose, not Ansible,
not projectctl — so every run would have died on
`Unable to find image 'pm-agent:latest'`. Image stores are per-daemon, so
building it once was not enough either. It is now built and exported once at
deploy time (`agent_image.yml`) and `docker load`ed into each project's daemon
at create time (`ensure_agent_image`), which also keeps a multi-minute failure
out of the create-project modal.

**7.5 The pm server crash-looped on every deploy.** `pnpm-workspace.yaml` said
`allowBuilds:`, which is not a pnpm setting — pnpm 10 silently ignored it, so
`better-sqlite3`'s postinstall never ran and the server died on
`Could not locate the bindings file`. The real key is `onlyBuiltDependencies`.
Alpine also needs a toolchain, since better-sqlite3 only publishes glibc
prebuilds; it is added and removed inside one `RUN` so it never reaches a layer.

**7.6 The Antigravity adapter was written against a CLI nobody had run.** It
copied Claude Code's flags. `agy --help` has no `--output-format` and no
`--verbose`, so every Antigravity run would have been rejected before
generating a token; `agy --print` emits plain text, not stream-json; and every
model id it advertised was wrong. Corrected against `agy --help` and
`agy models` on the host. Because output is plain text, Antigravity runs report
no cost and no result summary — `queue.ts` decides success from the container's
exit code, so this costs reporting detail, not correctness.

---

## 7b. What broke the first time an agent actually ran

Added 2026-07-25, from the session that closed §8's first two items. Every one
of these was invisible until a real credential let the agent container start,
and the first four are fatal on any fresh deploy of the pre-2026-07-25 tree.
Note the pattern: three of the six failed *silently*, and the two worst were
caught only by reading the runner's journal.

**7.7 Both CLIs refuse `--dangerously-skip-permissions` as root.** Every
implement run died 1.5 s in with a single line on stderr —
`--dangerously-skip-permissions cannot be used with root/sudo privileges for
security reasons` — and was recorded as an ordinary failed run. The agent
*must* be container root: under rootless Docker container root maps to the
project user on the host, which is the only uid that can write the bind-mounted
workspace. `IS_SANDBOX=1` is the CLIs' own escape hatch for this case and the
container genuinely satisfies it, so `agentDockerArgs` now sets it.

**7.8 The agent container had no git at all.** The implement phase hands the
agent a linked *worktree*, whose `.git` is a one-line file naming an absolute
host path (`<repo>/.git/worktrees/<name>`) that was not mounted. Every git
command inside the container failed with `fatal: not a git repository`, so the
agent could not do the commit its own prompt asks for. `agentDockerArgs` now
mounts the repo's git common dir at the identical path it names. The
clone-based phases (verify, review) were never affected — their checkouts are
self-contained.

This one hid behind a backstop: `commitAndPush` stages leftover changes, so the
run still "succeeded", the branch still reached origin, and the only trace was
that the commit message was pm's rather than the agent's.

**7.9 `task.branch` could never be recorded.** The runner called
`setTaskBranch` and it failed with `EACCES` on every implement run, caught and
logged to a journal nobody reads. `.pm/` is created by the pm server and lands
`pm:pm 0644` on the host; project users are deliberately never in the `pm`
group (§11), so the runner can read that tree but never write it. Recording the
branch is now pm's job, in `queue.ts`, right after `startRun` returns. The
runner-side test that "proved" the old behaviour passed only because a unit
test writes into a temp dir it owns.

**7.10 A rebuilt runner kept serving the old code.** The runner unit's
`ExecStart` is a path into `/srv/pm/app/runner/dist`, and the only restart
handler in the role covers the pm server. Rebuilding under a live runner left
it serving the previous module graph, so a deployed fix simply did not run —
the symptom being the bug still happening. `roles/pm/tasks/runner.yml` now
`try-restart`s each project runner that is actually up; idled projects pick the
new build up on their next run.

**7.11 Task-board writes were silently skipped for idle projects.** Only the
runner has git, so `commitAndPushBestEffort` gave up when a project had idled
out — `POST /tasks` returned `"pushed": false` and the board diverged from
origin until some later run happened to commit it. It now wakes the runner
first, sharing `ensureRunnerConnected` with the queue.

**7.12 nginx never saw a real client IP.** RootlessKit's default `builtin` port
driver terminates the inbound connection on the host and opens a fresh one into
the container, so `$remote_addr` was the bridge gateway `172.18.0.1` for every
request. That silently disabled the entire realip block: `set_real_ip_from`
lists Cloudflare's ranges, none of which ever matched, so `CF-Connecting-IP` was
never honoured. The pm user's docker now runs with
`DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns`, which preserves the
source address — which is what makes "trust `CF-Connecting-IP` only from
Cloudflare" an enforceable rule rather than a comment.

---

## 8. What is still unproven

Stated plainly rather than implied by omission. Everything below the line was
walked end to end on 2026-07-25 against `dev.goevolve.org`: task creation,
interview, plan, implement, the auto-queued verify, and review — with a real
Claude Code OAuth token, over the public Cloudflare path.

- **Antigravity has not been run end to end.** The flags, model ids and
  credential path are taken from the real CLI, but no `agy` run has ever
  executed inside the agent container. Note that §7.7 applies to it too: the
  `IS_SANDBOX` fix is set for every agent container, but only Claude Code's
  root check has actually been observed passing. Antigravity also reports no
  cost, because `agy --print` emits plain text (§7.6).
- **Nothing has been driven through the web UI.** Every step above was done
  over the API. The SPA is served and behind basic auth, but no button in it
  has been clicked — so the task board, the branch chip, the run viewer and the
  settings modal are unconfirmed as *UI*, even though the endpoints they call
  are not.
- **Only one project has ever existed.** Project-against-project isolation is
  the security property the whole design is built around (separate users,
  separate rootless daemons, separate credential mounts) and it has never been
  exercised with two projects on one host.
- **The `refine` phase has not been run.** It is the one phase with no
  coverage on a real host.
- **Artifact conversion beyond a text file is unconfirmed.** Verify collects
  `/pm-artifacts` and the reference repo drops a `.txt` there. The
  video→GIF conversion and screenshot-to-attachment paths have never had a
  video or a screenshot to work on.
- **Nothing has been observed under load or over time.** Concurrency is capped
  at two runs and the cap is tested, but no two agent runs have ever been in
  flight at once on the host, and `PM_DATA_DIR/artifacts` still has no
  retention policy (see the TODO in `app.ts`).

---

## 9. Updating the stack

```bash
git pull
ansible-playbook playbook.yml --vault-password-file ~/.pm-vault-pass -u root
```

The app sync notifies a `pm-compose.service` restart. Re-running is safe: the
agent image is only re-exported when its id changes, and `create` on an
existing project resumes rather than rebuilding.

---

## 10. Troubleshooting

| Symptom | Check |
|---------|-------|
| Play fails on `pm_auth_password` | It is unset. §2.2 |
| `pm-pm-1` restarting | `docker logs pm-pm-1` as the pm user. A missing native binding means §7.5 regressed |
| HTTPS 502 | pm container is down; see above |
| 401 with the right password | Re-run the play to regenerate htpasswd |
| Cloudflare 521 | `nft list set inet filter cloudflare4` must be non-empty |
| Project creation fails at preflight | A CREATE_TOOLS binary is missing from the system PATH; §7.3 |
| Project stuck `awaiting-key` | Deploy key missing or read-only. It needs **write** |
| Project `disconnected` | `systemctl --machine pm-<name>@.host --user status runner` |
| Run fails instantly with an image error | `docker image ls pm-agent` in the project's daemon; §7.4 |
| `pm-projectctl` hangs | `systemctl status pm-projectctl.socket`; `/srv/pm/projectctl.sock` must exist |

---

## 11. Security notes

- Provider credentials never appear in Ansible, on any argv, in any log, or in
  the agent container's process arguments — verified on the host. They reach
  the agent as a read-only mount, read inside the container by the shim.
- pm **does** hold each credential in plaintext, in `provider_creds.secret` in
  the SQLite DB under `/srv/pm/data`, owned by the `pm` user. This is
  deliberate and the reasoning is in `db/migrations/0003_provider_cred_secret.ts`:
  `pm-projectctl set-credential` is write-only, so there is nowhere else to
  read the value back from when a project is created *after* the key was
  entered. The isolation this system actually protects — project against
  project — is unchanged, since a project user only ever sees its own
  `~/.pm-creds`. An earlier version of this list claimed the opposite; it was
  wrong.
- `pm_auth_password` must be vault-encrypted before committing.
- The self-signed origin cert covers the Cloudflare→origin leg only.
- The `pm` group may connect to `pm-projectctl.socket`. Project users
  (`pm-<name>`) are deliberately never in it.
- `auth/htpasswd` is world-readable because nginx's worker runs as an unrelated
  uid under rootless Docker. bcrypt (`-B`) is what makes that acceptable.
