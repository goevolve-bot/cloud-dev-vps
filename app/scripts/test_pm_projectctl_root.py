"""Root integration tests for pm-projectctl's provisioning steps.

These really do create an OS user, allocate subordinate ids, mint a deploy key
and clone/push a repository, so they are opt-in:

    sudo PM_PROJECTCTL_ROOT_TESTS=1 python3 -m unittest \\
        discover -s app/scripts -p 'test_*_root.py'

They stop short of linger/rootless-docker/systemd (a live systemd is needed —
see README.md for the manual host check that covers those). Everything created
here is removed again in tearDown.
"""

from __future__ import annotations

import grp
import importlib.machinery
import importlib.util
import os
import pwd
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("pm-projectctl")
_loader = importlib.machinery.SourceFileLoader("pm_projectctl", str(MODULE_PATH))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
assert _spec is not None
ctl = importlib.util.module_from_spec(_spec)
_loader.exec_module(ctl)

PROJECT = "pmselftest"
REQUIRED_TOOLS = ["useradd", "userdel", "usermod", "ssh-keygen", "git"]


def _missing_requirements() -> str:
    if os.geteuid() != 0:
        return "must run as root"
    if not os.environ.get("PM_PROJECTCTL_ROOT_TESTS"):
        return "set PM_PROJECTCTL_ROOT_TESTS=1 to opt in"
    missing = [tool for tool in REQUIRED_TOOLS if shutil.which(tool) is None]
    if missing:
        return "missing tools: %s" % ", ".join(missing)
    return ""


@unittest.skipIf(_missing_requirements(), _missing_requirements() or "ok")
class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pmctl-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # A private `pm` group stand-in keeps the test off the real one.
        self.group = "pmtestgrp"
        try:
            grp.getgrnam(self.group)
        except KeyError:
            subprocess.run(["groupadd", self.group], check=True)
            self.addCleanup(subprocess.run, ["groupdel", self.group], check=False)
        self.cfg = ctl.Config(
            dict(
                ctl.DEFAULT_CONFIG,
                pm_group=self.group,
                runners_dir=os.path.join(self.tmp, "runners"),
                state_dir=os.path.join(self.tmp, "projects"),
            )
        )
        self.addCleanup(self._remove_user)
        self.pw = ctl.ensure_user(self.cfg, PROJECT)

    def _remove_user(self):
        subprocess.run(["userdel", "-r", self.cfg.user_for(PROJECT)], capture_output=True)

    def _mode(self, path: str) -> int:
        return stat.S_IMODE(os.stat(path).st_mode)

    def _group_of(self, path: str) -> str:
        return grp.getgrgid(os.stat(path).st_gid).gr_name

    def test_user_creation_is_idempotent(self):
        again = ctl.ensure_user(self.cfg, PROJECT)
        self.assertEqual(again.pw_uid, self.pw.pw_uid)
        self.assertEqual(again.pw_name, "pm-" + PROJECT)

    def test_subid_ranges_exist_and_do_not_overlap(self):
        ctl.ensure_subids(self.cfg, self.pw.pw_name)
        for path in ("/etc/subuid", "/etc/subgid"):
            with open(path, encoding="utf-8") as handle:
                entries = ctl.parse_subid_file(handle.read())
            mine = [entry for entry in entries if entry[0] == self.pw.pw_name]
            self.assertEqual(len(mine), 1, path)
            start, count = mine[0][1], mine[0][2]
            for name, other_start, other_count in entries:
                if name == self.pw.pw_name:
                    continue
                self.assertFalse(
                    start < other_start + other_count and other_start < start + count,
                    "range for %s overlaps %s in %s" % (self.pw.pw_name, name, path),
                )

    def test_home_layout_exposes_the_board_but_not_the_secrets(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        home = self.pw.pw_dir
        # pm may traverse the home (--x) but not enumerate it.
        self.assertEqual(self._mode(home), 0o710)
        self.assertEqual(self._group_of(home), self.group)
        # The work tree is group-readable and setgid, so `.pm/` stays reachable.
        self.assertEqual(self._mode(os.path.join(home, "work")), 0o2750)
        self.assertEqual(self._group_of(os.path.join(home, "work")), self.group)
        # Secrets are owner-only, in the project user's own group.
        for secret in (".ssh", ".pm-creds"):
            path = os.path.join(home, secret)
            self.assertEqual(self._mode(path), 0o700, path)
            self.assertEqual(self._group_of(path), self.pw.pw_name, path)

    def test_runner_dir_is_owned_by_the_project_and_shared_only_with_pm(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        path = ctl.ensure_runner_dir(self.cfg, PROJECT, self.pw)
        self.assertEqual(self._mode(path), 0o2750)
        self.assertEqual(os.stat(path).st_uid, self.pw.pw_uid)
        self.assertEqual(self._group_of(path), self.group)

    def test_deploy_key_is_private_and_returned_as_a_public_key(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        public_key = ctl.ensure_deploy_key(self.cfg, PROJECT, self.pw)
        self.assertTrue(public_key.startswith("ssh-ed25519 "))
        key_path = ctl.deploy_key_path(self.pw)
        self.assertEqual(self._mode(key_path), 0o600)
        self.assertEqual(os.stat(key_path).st_uid, self.pw.pw_uid)
        # Regenerating must not rotate a key the remote already trusts.
        self.assertEqual(ctl.ensure_deploy_key(self.cfg, PROJECT, self.pw), public_key)

    def test_empty_repo_is_cloned_scaffolded_and_pushed(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        ctl.ensure_deploy_key(self.cfg, PROJECT, self.pw)
        remote = os.path.join(self.tmp, "demo.git")
        subprocess.run(["git", "init", "--bare", "-q", remote], check=True)
        ctl.chown_tree(remote, self.pw.pw_uid, self.pw.pw_gid)
        os.chmod(self.tmp, 0o755)

        dest, failure = ctl.clone_repo(self.cfg, self.pw, "file://" + remote)
        self.assertIsNone(failure)
        self.assertEqual(dest, os.path.join(self.pw.pw_dir, "work", "demo"))

        result = ctl.scaffold_pm_tree(self.cfg, self.pw, dest)
        self.assertTrue(result["scaffolded"])
        self.assertTrue(result["pushed"], result.get("pushError"))

        listing = subprocess.run(
            ["git", "--git-dir=" + remote, "ls-tree", "-r", "--name-only", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.split()
        self.assertIn(".pm/README.md", listing)
        self.assertIn(".pm/tasks/todo/.gitkeep", listing)
        self.assertIn(".pm/adrs/.gitkeep", listing)

        # pm (in group `pm`, not the project's own private group) must be
        # able to write directly into .pm/, not just read it.
        pm_dir = os.path.join(dest, ".pm")
        self.assertEqual(self._mode(pm_dir), 0o2770)
        self.assertEqual(self._group_of(pm_dir), self.group)
        todo_dir = os.path.join(pm_dir, "tasks", "todo")
        self.assertEqual(self._mode(todo_dir), 0o2770)
        self.assertEqual(self._group_of(todo_dir), self.group)
        readme = os.path.join(pm_dir, "README.md")
        self.assertEqual(self._mode(readme), 0o660)
        self.assertEqual(self._group_of(readme), self.group)

        # Re-running create must not clone twice or commit an empty change.
        self.assertEqual(ctl.clone_repo(self.cfg, self.pw, "file://" + remote), (dest, None))
        self.assertEqual(
            ctl.scaffold_pm_tree(self.cfg, self.pw, dest),
            {"scaffolded": False, "pushed": False},
        )

    def test_unreachable_repo_reports_awaiting_key_and_leaves_no_debris(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        ctl.ensure_deploy_key(self.cfg, PROJECT, self.pw)
        dest, failure = ctl.clone_repo(
            self.cfg, self.pw, "file://" + os.path.join(self.tmp, "absent.git")
        )
        self.assertEqual(failure, "awaiting-key")
        self.assertFalse(os.path.exists(dest))

    def test_set_credential_writes_an_owner_only_file(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        events = []
        result = ctl.verb_set_credential(
            {"name": PROJECT, "key": "claude", "value": "sk-secret-token"},
            self.cfg,
            lambda step, message: events.append((step, message)),
        )
        self.assertEqual(result, {"name": PROJECT, "key": "claude", "written": True})
        path = os.path.join(self.pw.pw_dir, ".pm-creds", "claude")
        self.assertEqual(self._mode(path), 0o600)
        self.assertEqual(os.stat(path).st_uid, self.pw.pw_uid)
        self.assertEqual(self._group_of(path), self.pw.pw_name)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "sk-secret-token")
        self.assertTrue(events)

    def test_set_credential_overwrites_in_place(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        ctl.verb_set_credential({"name": PROJECT, "key": "claude", "value": "one"}, self.cfg, lambda *a: None)
        ctl.verb_set_credential({"name": PROJECT, "key": "claude", "value": "two"}, self.cfg, lambda *a: None)
        path = os.path.join(self.pw.pw_dir, ".pm-creds", "claude")
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "two")

    def test_delete_removes_the_user_but_keeps_home_without_purge(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        ctl.write_state(self.cfg, PROJECT, {"gitUrl": "git@example.com:x.git", "status": "ready"})
        home = self.pw.pw_dir
        self.addCleanup(shutil.rmtree, home, True)

        result = ctl.verb_delete({"name": PROJECT}, self.cfg, lambda *a: None)
        self.assertEqual(result, {"name": PROJECT, "deleted": True, "purged": False})

        with self.assertRaises(KeyError):
            pwd.getpwnam(self.cfg.user_for(PROJECT))
        self.assertTrue(os.path.isdir(home))
        self.assertFalse(os.path.exists(ctl.state_path(self.cfg, PROJECT)))
        self.assertFalse(os.path.isdir(ctl.runner_dir_path(self.cfg, PROJECT)))

    def test_delete_purge_removes_home_too(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        home = self.pw.pw_dir
        self.addCleanup(shutil.rmtree, home, True)

        result = ctl.verb_delete({"name": PROJECT, "purge": True}, self.cfg, lambda *a: None)
        self.assertEqual(result, {"name": PROJECT, "deleted": True, "purged": True})
        self.assertFalse(os.path.exists(home))

    def test_delete_is_idempotent_with_the_create_error_contract(self):
        ctl.ensure_home_layout(self.cfg, self.pw)
        self.addCleanup(shutil.rmtree, self.pw.pw_dir, True)
        ctl.verb_delete({"name": PROJECT}, self.cfg, lambda *a: None)
        with self.assertRaises(ctl.PmError) as caught:
            ctl.verb_delete({"name": PROJECT}, self.cfg, lambda *a: None)
        self.assertEqual(caught.exception.code, "unknown_project")


if __name__ == "__main__":
    unittest.main()
