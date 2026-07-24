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

## Not covered by these batches

Two items need a real VPS and cannot be closed from a laptop:

- **Verify against a real sample repo** (review §3.9). B3 fixes the code, but the
  `compose up --wait` behaviour with one-shot services must be confirmed on-host.
- **Antigravity flags** (review §6, T38). The adapter assumes `agy` accepts Claude
  Code's exact flag set. Someone has to run `agy --help` on the VPS.

After B1–B4 land, walk the green path on the host once, then rewrite
`docs/pm-runbook.md` to describe what actually happened (review §8, "Then honesty").
