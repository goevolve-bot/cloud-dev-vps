# PM System — Deployment Runbook

> **T43 deliverable** — documents the green path from a bare VPS to a running
> PM stack with a real project, an implement run, and verified artifacts.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Ansible ≥ 2.14 on the control node | `pip install ansible` |
| VPS running Debian 12 (Bookworm) | Root or sudo-capable SSH key |
| Domain pointing at the VPS, proxied through Cloudflare | Full (strict) TLS mode |
| A git repository you want to manage | Public or accessible with deploy key |

---

## 1. Initial provisioning

### 1.1 Clone the ops repo

```bash
git clone git@github.com:titarenko/cloud-dev-vps.git
cd cloud-dev-vps
```

### 1.2 Set the vault password

The `pm_auth_password` in `group_vars/all.yml` must be replaced with a
vault-encrypted value before running against production:

```bash
# Create a vault password file (keep it out of the repo)
echo 'your-vault-password' > ~/.pm-vault-pass
chmod 600 ~/.pm-vault-pass

# Encrypt the web-UI password
ansible-vault encrypt_string 'your-web-password' \
  --name pm_auth_password \
  --vault-password-file ~/.pm-vault-pass
```

Paste the output into `group_vars/all.yml`, replacing the plaintext stub.

### 1.3 Set your inventory

`inventory.ini` should contain the VPS hostname/IP:

```ini
[vps]
your-vps-hostname-or-ip
```

### 1.4 Run the playbook

```bash
ansible-playbook playbook.yml \
  --vault-password-file ~/.pm-vault-pass \
  -u root          # or your sudo user with -K
```

Expected output (abridged):

```
PLAY RECAP ******************************************************************
your-vps : ok=54  changed=18  unreachable=0  failed=0
```

**Done criteria (T39–T42):**

- `systemctl --user -M pm@ status pm-compose.service` → `active (running)`
- `curl -sk -u pm:<password> https://localhost:443/` → HTTP 200 or the PM UI
- `nft list ruleset` → shows `tcp dport 443` accept rule for Cloudflare ranges
- `systemctl status pm-projectctl.socket` → `active (listening)`

---

## 2. Cloudflare configuration

1. In the Cloudflare dashboard, set SSL/TLS mode to **Full (strict)**.
2. Point your domain's A/AAAA record at the VPS.  Proxy must be **enabled** (orange cloud).
3. Verify the origin cert: `openssl s_client -connect your-domain:443 -servername your-domain`

> The nftables ruleset (T42) only accepts :443 connections from Cloudflare
> IP ranges.  Direct connections to the origin IP will be dropped.  If you
> need temporary direct access for debugging, set `pm_nftables_cloudflare_only: false`
> in `group_vars/all.yml` and re-run the playbook.

---

## 3. Adding your first project

1. Open `https://your-domain` in a browser, log in with username **pm** and
   the password you set.
2. Click **+ New project** in the header.
3. Enter a project name (lowercase letters, digits, hyphens — e.g. `my-app`).
4. Paste the HTTPS or SSH git URL of the repository.
5. Click **Create**.  The UI will display the deploy key — add it as a
   read/write deploy key in your git provider.
6. The project card shows `active` once the runner socket is detected.

---

## 4. Running implement → verify on a sample task

### 4.1 Create a task

1. Select the project, go to **Tasks**, click **+ New task**.
2. Fill in a title and description.  For a smoke test, something minimal:
   - **Title**: `Add hello endpoint`
   - **Description**: `Add GET /hello that returns {"hello":"world"} and a corresponding test.`
3. Click **Save**.

### 4.2 Launch an implement run

1. Open the task.
2. In the launch bar, select:
   - **Phase**: Implement
   - **Provider**: Claude (or Antigravity if configured)
   - **Model**: leave at the project default
3. Click **Run**.
4. The timeline shows the live log stream.  Watch the agent edit files and
   commit.

### 4.3 Verify runs automatically

After a successful implement, verify runs automatically (T28).  The verify
phase:

1. Checks out the task branch into a fresh Docker volume.
2. Runs `docker compose up --build --wait` on the project's compose stack.
3. Executes the `test` and (if present) `e2e` services.
4. Collects artifacts from the `./pm-artifacts` directory.

The timeline shows a **pass** or **fail** chip.  Screenshots and GIFs (if any)
appear in the artifacts gallery below the timeline.

### 4.4 Merge the branch

Once the task is accepted (click **Accept** on the review findings or the task
passes verify automatically):

- The task moves to `done`.
- The branch is available on `origin` — create a pull request or merge
  manually from the repository.

---

## 5. Updating the stack

To deploy a new version of the PM app:

```bash
# On the control node
git pull
ansible-playbook playbook.yml \
  --vault-password-file ~/.pm-vault-pass \
  --tags pm          # only run the pm role
```

The `synchronize` task in `roles/pm/tasks/base.yml` copies the updated source,
rebuilds images, and triggers a `pm-compose.service` restart via the handler.

---

## 6. Troubleshooting

| Symptom | Check |
|---------|-------|
| `pm-compose.service` fails to start | `journalctl --user -u pm-compose -n 50 -M pm@` |
| HTTPS returns 502 | `docker compose -p pm logs pm` (inside pm user session) |
| Auth returns 401 | Re-run playbook to regenerate htpasswd; ensure `pm_auth_password` is set |
| Cloudflare 521 | Check nftables: `nft list set inet filter cloudflare4` must be non-empty |
| `pm-projectctl` hangs | `systemctl status pm-projectctl.socket`; check `/srv/pm/projectctl.sock` exists |
| Runner socket not detected | Check project user's rootless Docker: `systemctl --user status docker -M pm-<name>@` |

---

## 7. Security notes

- **No provider credentials in Ansible** — provider API keys are written
  directly through `pm-projectctl set-credential` from the UI (T36/T41).
- **pm_auth_password must be vault-encrypted** before committing to the repo.
- The self-signed origin cert is for the Cloudflare→origin leg only.
  Cloudflare presents a real cert to the browser.
- The `pm` group is the only group allowed to connect to the
  `pm-projectctl.socket`.  Project users (`pm-<name>`) never get this
  permission.
