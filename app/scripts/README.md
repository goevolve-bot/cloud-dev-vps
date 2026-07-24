# `pm-projectctl`

The PM system's single root-touching interface (tasks T07 + T08 in
`docs/pm-task-breakdown.md`). The pm web app runs unprivileged as user `pm`,
holds no project docker socket and no project secret; everything privileged
happens here, behind a validated verb set on a unix socket owned `root:pm`.

Python 3 stdlib only, one file, no dependencies — it runs as root, so it has to
stay auditable in one sitting and must not carry a package tree of its own.

## Files

| File | Purpose |
|------|---------|
| `pm-projectctl` | the helper itself (daemon, verbs, and a CLI client) |
| `pm-projectctl.socket` | systemd socket unit — `/srv/pm/projectctl.sock`, `root:pm`, 0660 |
| `pm-projectctl.service` | systemd service unit — runs `pm-projectctl serve` |
| `test_pm_projectctl.py` | unit tests (no root needed) |
| `test_pm_projectctl_root.py` | opt-in root integration tests (creates and removes a real user) |

Deployed by `roles/pm` (T41) to `/usr/local/sbin/pm-projectctl`.

## Verbs

| Verb | Arguments | Result |
|------|-----------|--------|
| `create` | `name`, `gitUrl` | provisions the project; returns the deploy public key |
| `start` | `name` | starts the project's rootless docker + runner |
| `stop` | `name` | stops the runner + rootless docker |
| `status` | `name` (optional) | per-project unit states, socket presence, metadata |

`delete` and `set-credential` are T09.

### Protocol

One newline-delimited JSON request per connection; the reply is a stream of
NDJSON events ending in exactly one `result` or `error`:

```
-> {"verb":"create","args":{"name":"demo","gitUrl":"git@github.com:me/demo.git"}}
<- {"type":"progress","step":"user","message":"creating user pm-demo"}
<- {"type":"progress","step":"clone","message":"cloning git@github.com:me/demo.git"}
<- {"type":"result","ok":true,"data":{"status":"ready","publicKey":"ssh-ed25519 …", …}}
```

Error events carry a stable `code` (`invalid_name`, `invalid_url`,
`unknown_project`, `missing_dependency`, `busy`, `command_failed`, …) so the
API layer can map them to responses without parsing prose.

### CLI

```bash
pm-projectctl serve                      # the daemon (root)
pm-projectctl create demo git@github.com:me/demo.git   # run the verb locally
pm-projectctl --remote status            # or send it over the control socket
pm-projectctl --socket /srv/pm/projectctl.sock start demo
```

Progress goes to stderr, the result to stdout as JSON; exit status is 0 only on
a `result` event.

## What `create` does

1. **user** — `pm-<name>` with `/usr/sbin/nologin`, plus subordinate uid/gid
   ranges (allocated explicitly, above every existing range, if `useradd`
   didn't).
2. **home** — the permission boundary, per `docs/pm-system-plan.md`:

   | Path | Mode | Owner | Who can read it |
   |------|------|-------|-----------------|
   | `~` | 0710 | `pm-<name>:pm` | pm may traverse, not enumerate |
   | `~/work/` | 2750 | `pm-<name>:pm` | pm reads `.pm/`; setgid keeps new files in group `pm` |
   | `~/.ssh/` | 0700 | `pm-<name>:pm-<name>` | the project user only — deploy key |
   | `~/.pm-creds/` | 0700 | `pm-<name>:pm-<name>` | the project user only — provider tokens (T09) |
   | `/srv/pm/runners/<name>/` | 2750 | `pm-<name>:pm` | the runner binds here, pm connects |

3. **linger + docker** — `loginctl enable-linger`, then
   `dockerd-rootless-setuptool.sh install` and `enable --now docker` in the
   user's own systemd manager. The socket stays at `/run/user/<uid>/docker.sock`
   — private to the project user, never shared with pm.
4. **key** — an ed25519 deploy key (0600) plus an `~/.ssh/config` pinning it;
   the public key comes back in the result for the UI to display.
5. **clone** — `git clone -- <url> ~/work/<repo>` as the project user. If the
   remote rejects the key, the call returns `status: "awaiting-key"` with the
   public key instead of failing: add the key to the repository and **call
   `create` again** — every step is idempotent, so it resumes at the clone.
   This is what backs the UI's two-step "add project" modal.
6. **scaffold** — creates `.pm/` (tasks/specs/adrs) and commits + pushes it on
   the default branch if the repo doesn't have one. A push failure is reported
   as a warning, not a failure; the local board is still valid.
7. **runner** — writes `~/.config/systemd/user/runner.service` and starts it.
   `UMask=0007` plus the setgid runner directory make the control socket
   `0770 pm-<name>:pm`: pm can connect, other project users cannot even
   traverse the directory.

### Why `/srv/pm/runners/<name>/control.sock` and not `<name>.sock`

A flat file would require every project user to share write access to one
directory, which also makes every runner socket reachable by every other
project — the exact boundary the per-project OS user exists to draw. A
per-project directory owned `pm-<name>:pm` gives the runner a place to bind, pm
a path to connect to, and everyone else nothing.

## Safety properties

- **No shell, ever.** Every command is `execve`'d with an argv array. A URL
  like `https://x/y;rm -rf ~` cannot become a token; `git clone -- <url>` also
  stops a `-`-prefixed URL from being read as a flag.
- **Allow-listed transports.** Only `https://`, `ssh://` and `user@host:path`.
  `ext::` (which runs an arbitrary command) and `file://` are rejected before
  git ever sees the string.
- **Validated names.** `[a-z0-9-]`, alphanumeric at both ends, ≤ 29 chars — so
  a name can never escape a path or overflow a username.
- **One operation per project at a time**, enforced with `flock`.
- **The pm app cannot escalate through this.** The verb set is fixed, every
  argument is validated, and the socket is group `pm` — project users are
  never in that group.

## Configuration

Defaults are compiled in; `/etc/pm-projectctl.conf` (JSON) overrides them, and
`PM_PROJECTCTL_CONFIG` overrides the path. Unknown keys are rejected. The one a
deployment usually sets is `runner_exec`:

```json
{ "runner_exec": ["/usr/bin/node", "/srv/pm/app/runner/dist/index.js"] }
```

## Tests

```bash
python3 -m unittest discover -s app/scripts        # unit tests (root tests skip)
sudo PM_PROJECTCTL_ROOT_TESTS=1 \
  python3 -m unittest discover -s app/scripts -p 'test_*_root.py'
```

The root suite creates a real `pm-pmselftest` user, allocates subordinate ids,
mints a key, and clones/scaffolds/pushes a local bare repo, then removes
everything again.

### Manual host check (needs a live systemd)

Linger, rootless docker and `systemctl --machine` cannot be exercised in a
container. On the VPS:

```bash
sudo pm-projectctl create demo git@github.com:me/demo.git
# add the printed key to the repo if it reports awaiting-key, then re-run
sudo pm-projectctl status demo     # docker: active, runner: active, socketPresent: true
sudo pm-projectctl stop demo && sudo pm-projectctl status demo   # both inactive
sudo pm-projectctl start demo
```

`--machine=<user>@.host` needs the `systemd-container` package on the host.
