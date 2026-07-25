# Finalize the PM system on the VPS

**Fill in the two values below, then paste this whole file as the first message
of a fresh session.** Everything else the session needs is already here — it
should not have to ask you anything.

---

## Values you must fill in

```
CLAUDE_CODE_OAUTH_TOKEN = sk-ant-oat01-________________________________
PM_DOMAIN               = ________________________________
```

`CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token` on any machine where
you are logged in. A console API key (`sk-ant-api…`) works too — the credential
shim distinguishes them by prefix, and testing that it does is part of the job.

`PM_DOMAIN` is the Cloudflare-proxied hostname pointing at `77.42.33.187`.
If you have not set one up, write `none` and skip §4.

---

## The task

The PM system is deployed and working on `77.42.33.187`. The green path was
walked on 2026-07-25 up to and including verify. **Two things were never
exercised, both because no provider credential was available at the time:**

1. The agent phases themselves — implement, plan, review. Everything
   *downstream* of the agent container is confirmed; the container has never
   run.
2. The public Cloudflare path. All verification so far was over loopback.

Close both. Fix whatever breaks. Then update `docs/pm-runbook.md` §8 ("What is
still unproven") to reflect what is actually left, and commit.

Read `docs/pm-runbook.md` first — §7 lists five blockers that a real host
surfaced last time, and §8 states precisely what remains. Do not re-read the
`docs/pm-remediation/` batches; they are closed.

---

## State you are inheriting

| Thing | Value |
|---|---|
| VPS | `77.42.33.187`, Debian 13, root SSH key access from this box |
| Branch | `app`, last commit `c09ef48` "Make it run on a real VPS" — committed, **not pushed** |
| Ansible | `~/.local/bin/ansible-playbook` (installed via uv; not on PATH by default) |
| Vault password | `~/.pm-vault-pass` |
| Web login | user `pm`; get the password with `ansible-vault view` or see below |
| Smoke repo | `goevolve-bot/pm-smoke`, private, read-write deploy key installed |
| Project | `smoke`, runner `connected`, contract compliant |
| Task 1 | "Add a version endpoint", at `ready-for-review`, verify run 1 succeeded |

Deploy command (the whole play is idempotent, ~90 s warm):

```bash
export PATH=$HOME/.local/bin:$PATH
cd /home/debian/cloud-dev-vps
ansible-playbook playbook.yml --vault-password-file ~/.pm-vault-pass -u root
```

Reaching the API from the host — the firewall drops :443 from everywhere except
Cloudflare, but `iif lo accept` comes first, so loopback works:

```bash
ssh root@77.42.33.187
PASS=$(cd /home/debian/cloud-dev-vps && ansible-vault view ...)   # or read it from your notes
curl -sk -u pm:$PASS https://127.0.0.1/api/projects
```

The password for the deployed stack is `ibPndWvbFHSBpb5UeIdzbT5F`. It is
vault-encrypted in `group_vars/all.yml`; rotate it if you like, but that means a
redeploy.

---

## §1 — Deliver the credential

Set it through the real path, not by writing the file by hand — the delivery
chain is part of what is being tested.

```bash
curl -sk -u pm:$PASS -H 'Content-Type: application/json' \
  -d '{"type":"api-key","key":"<CLAUDE_CODE_OAUTH_TOKEN>"}' \
  https://127.0.0.1/api/providers/claude/connect
```

Then confirm it actually arrived where the agent will look:

- `/home/pm-smoke/.pm-creds/anthropic` exists, owned by `pm-smoke`, mode `0600`
- `GET /api/providers` shows `claude` as `connected` with a masked key
- The value is **not** visible in `ps`, in the runner's journal, or in the
  container's argv

Do not echo the token into any log or commit message.

---

## §2 — Run implement end to end

Create a **new** task (task 1 is already at `ready-for-review`; leave it as the
verify-only evidence). Something small and checkable, e.g. "Add GET /ping
returning `{"pong":true}` and a unit test".

```bash
curl -sk -u pm:$PASS -H 'Content-Type: application/json' \
  -d '{"title":"...","description":"..."}' \
  https://127.0.0.1/api/projects/smoke/tasks

curl -sk -u pm:$PASS -H 'Content-Type: application/json' \
  -d '{"phase":"implement","provider":"claude","model":"claude-sonnet-5"}' \
  https://127.0.0.1/api/projects/smoke/tasks/<N>/runs
```

Watch it with `tail -f /home/pm-smoke/logs/<runId>.log` on the host, and via
`GET /api/runs/<id>/events` (SSE) so you exercise the streaming path too.

**Done means all of these, checked individually:**

- The `pm-agent` container starts and the CLI authenticates. A 401 here means
  the shim picked the wrong variable — see `CREDENTIAL_DELIVERY` in
  `app/runner/src/handlers.ts`, which chooses `CLAUDE_CODE_OAUTH_TOKEN` for
  `sk-ant-oat*` and `ANTHROPIC_API_KEY` otherwise.
- The agent edits files **and commits** — the implement prompt instructs it to,
  and `commitAndPush` stages any residue as a backstop. Confirm both halves:
  that a commit exists, and that nothing was left uncommitted.
- Branch `pm/task-<N>-<slug>` reaches `origin` with real content.
- `task.branch` is set on the task. It was `null` after the hand-pushed verify
  and has never been confirmed — this is the one assertion most likely to fail.
- A verify run is queued **automatically** on success, and passes.
- The task lands at `ready-for-review` without anyone touching the dropdown.
- `cost_usd`, `tokens_in`, `tokens_out` on the run row are non-zero and
  plausible. `GET /api/costs/mtd` reflects them.
- The run's real container exit code is recorded, not a synthetic 0/1.

## §3 — Run plan and review

- **plan** on a fresh task. Check the interview questions path works.
- **review** on the implemented task. Two things here have never run: review
  is supposed to work against a *fresh checkout with the project env started*,
  and the diff is supposed to be produced by the **runner**, not by pm shelling
  out to git — the pm image has no git at all. If the review prompt receives
  `Could not generate git diff: …`, that regressed.

## §4 — The public path (skip if PM_DOMAIN is `none`)

- `https://<PM_DOMAIN>/` returns the SPA with basic auth, 401 without.
- Direct `https://77.42.33.187/` from off-host **times out** — the firewall is
  doing its job.
- SSE survives Cloudflare: create a project or start a run through the domain
  and confirm events arrive incrementally rather than in one buffered dump.
  `proxy_buffering off` is set for this; Cloudflare can still buffer, and if it
  does, say so plainly rather than working around it silently.
- nginx logs the real client IP, not a Cloudflare edge IP (`real_ip_header
  CF-Connecting-IP`).

## §5 — Close out

- Update `docs/pm-runbook.md` §8 to say what is *now* unproven. Delete the
  entries you closed; do not leave them phrased as if still open. If something
  new turned out to be broken, add it to §7 with the same honesty as the rest.
- If the Antigravity path is still untested, leave it in §8 and say so — do not
  claim it works. Its flags and credential mechanism were corrected against the
  real CLI but no `agy` run has ever executed in the agent container.
- One commit on `app`. Do not push.
- Tell me what to delete: the smoke repo (`gh repo delete goevolve-bot/pm-smoke`)
  and its deploy key, unless you recommend keeping them as a regression fixture.

---

## Rules

- **Verify on the host, not by reading code.** The last session's five blockers
  all passed code review and all failed on real hardware.
- `failed=0` from Ansible is not proof the stack works. Check that `pm-pm-1` and
  `pm-nginx-1` are `Up`, not `Restarting`.
- If something is broken, fix it properly rather than working around it on the
  host — a fix that only exists on the VPS is lost at the next redeploy.
- Run `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint`, and
  `python3 -m unittest discover -s app/scripts` before committing. All were
  green at `c09ef48`: 25 core + 16 runner + 54 server + 53 python.
- Add tests for anything you fix.
- If a step is blocked, finish everything else and say explicitly what you left
  and why. Do not report partial work as complete.

---

## Which model

**Use Opus 5.** This is iterative debugging against a live host: long feedback
loops, failures that only appear at deploy time, and judgement calls about
whether a symptom is a bug in the code or in the environment. That is the work
Opus is worth paying for — the previous session needed six deploys and each
failure was a different subsystem.

Sonnet 5 would be reasonable only for §4 alone (the Cloudflare checks are
mechanical). It is a poor fit for §2 and §3, where the interesting failures are
silent ones — a 401 that looks like a model error, a commit that never happened,
a diff that quietly arrives empty.
