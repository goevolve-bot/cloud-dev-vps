# PM remediation batches

Four self-contained work orders derived from `docs/pm-implementation-review.md`.
Each is a complete prompt: start a fresh session and say **"proceed with B1.md"**
(or B2/B3/B4). You do not need to read the review doc first — everything each
batch needs is inline.

Run them **in order**, one per session, with `/clear` between. B2 depends on B1's
mounts; B3 depends on B2's protocol changes only lightly; B4 is a sweep and can
in principle move earlier, but its lint pass is most useful last.

| Batch | Scope | Suggested model |
|---|---|---|
| `B1.md` | Deployment wiring: volumes, SPA serving, runner deploy, Ansible auth/sysctl | Opus |
| `B2.md` | Project creation API + modal, credential delivery end-to-end | Opus |
| `B3.md` | Runner + queue: commits, run IDs, verify, races, status transitions | Opus |
| `B4.md` | Sweep: path traversal, review diff, model lists, contract, costs, UI, lint | Sonnet |

Batches are grouped by **file locality**, not by issue number, so each file is
read once instead of a dozen times. The `§` references point back to sections of
`docs/pm-implementation-review.md` if you want the original wording.

## Not covered by these batches — CLOSED 2026-07-25

Both items needed a real VPS. Both were done on one:

- **Verify against a real sample repo** (review §3.9) — **confirmed working**.
  `compose up --wait` scoped to the long-running services does not block on
  one-shot `test`/`e2e`. A verify run against a pushed branch cloned from
  origin, ran both suites, collected artifacts, tore down cleanly, and moved
  the task to `ready-for-review`.
- **Antigravity flags** (review §6, T38) — **the assumption was wrong**. `agy`
  has no `--output-format` and no `--verbose`, `--print` emits plain text rather
  than stream-json, every advertised model id was invalid, and there is no
  `ANTIGRAVITY_API_KEY` at all (it authenticates from a JSON OAuth file). All
  four are fixed against the real CLI.

Deploying to a bare host surfaced five further blockers that no amount of
reading could have caught — a crash-looping server, no Docker for project
users, an agent image nobody built. They are written up in
`docs/pm-runbook.md` §7, along with §8, "What is still unproven".
