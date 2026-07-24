"""Unit tests for pm-projectctl.

Run: python3 -m unittest discover -s app/scripts

These cover everything that does not need root or a live systemd: input
validation, argv construction, subordinate-id allocation, unit rendering, and a
full request round-trip over a real unix socket. Provisioning itself is
verified on a host — see app/scripts/README.md.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import pwd
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("pm-projectctl")
_loader = importlib.machinery.SourceFileLoader("pm_projectctl", str(MODULE_PATH))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
assert _spec is not None
ctl = importlib.util.module_from_spec(_spec)
_loader.exec_module(ctl)


def default_config() -> "ctl.Config":
    return ctl.Config(dict(ctl.DEFAULT_CONFIG))


def fake_passwd(name: str = "pm-demo", uid: int = 1200) -> "pwd.struct_passwd":
    return pwd.struct_passwd((name, "x", uid, uid, "", "/home/%s" % name, "/usr/sbin/nologin"))


class ProjectNameTests(unittest.TestCase):
    def test_accepts_plain_names(self):
        for name in ("demo", "a", "my-project-1", "x9", "a" * 29):
            self.assertEqual(ctl.validate_project_name(name), name)

    def test_rejects_bad_names(self):
        for name in (
            "",
            "Demo",
            "-demo",
            "demo-",
            "de mo",
            "demo/../etc",
            "demo.prod",
            "demo_prod",
            "a" * 30,
            "проект",
            None,
            42,
        ):
            with self.assertRaises(ctl.PmError) as caught:
                ctl.validate_project_name(name)
            self.assertEqual(caught.exception.code, "invalid_name")


class CredentialKeyTests(unittest.TestCase):
    def test_accepts_plain_keys(self):
        for key in ("claude", "antigravity-api-key", "a", "k" * 64):
            self.assertEqual(ctl.validate_credential_key(key), key)

    def test_rejects_bad_keys(self):
        for key in ("", "Claude", "1claude", "claude key", "claude/../etc", "k" * 65, None, 42):
            with self.assertRaises(ctl.PmError) as caught:
                ctl.validate_credential_key(key)
            self.assertEqual(caught.exception.code, "invalid_key")


class GitUrlTests(unittest.TestCase):
    def test_accepts_allowed_schemes(self):
        for url in (
            "https://github.com/titarenko/repo.git",
            "ssh://git@github.com:22/titarenko/repo.git",
            "git@github.com:titarenko/repo.git",
            "git@gitea.example.com:team/repo",
        ):
            self.assertEqual(ctl.validate_git_url(url), url)

    def test_rejects_dangerous_transports_and_injection(self):
        for url in (
            "",
            None,
            "file:///etc/passwd",
            "ext::sh",
            "ext::sh -c 'id >&2'",
            "git://example.com/x.git",
            "http://github.com/x/y.git",
            "/srv/pm/projects",
            "--upload-pack=/bin/sh",
            "-oProxyCommand=id",
            "https://x.com/a;rm -rf ~",  # space => rejected outright
            "https://x.com/a\nrm -rf ~",
            "https://x.com/a\0b",
            " https://x.com/a",
            "https://" + "a" * 600,
        ):
            with self.assertRaises(ctl.PmError) as caught:
                ctl.validate_git_url(url)
            self.assertEqual(caught.exception.code, "invalid_url")

    def test_shell_metacharacters_stay_one_argv_entry(self):
        # No shell is involved, so a metacharacter-bearing URL that passes the
        # allow-list is still a single opaque argument for git to parse.
        url = "https://example.com/a$(id).git"
        argv = ctl.clone_argv(ctl.validate_git_url(url), "/home/pm-demo/work/a")
        self.assertEqual(argv, ["git", "clone", "--", url, "/home/pm-demo/work/a"])
        self.assertEqual(argv.index("--"), 2)


class RepoNameTests(unittest.TestCase):
    def test_derives_directory_name(self):
        cases = {
            "https://github.com/titarenko/repo.git": "repo",
            "https://github.com/titarenko/repo": "repo",
            "https://github.com/titarenko/repo/": "repo",
            "git@github.com:titarenko/my-repo.git": "my-repo",
            "git@github.com:repo.git": "repo",
            "ssh://git@host/a/b/c.git": "c",
        }
        for url, expected in cases.items():
            self.assertEqual(ctl.repo_dir_name(url), expected)

    def test_rejects_unusable_tail(self):
        for url in ("https://example.com/", "git@host:.git", "https://example.com/.."):
            with self.assertRaises(ctl.PmError):
                ctl.repo_dir_name(url)


class SubidTests(unittest.TestCase):
    def test_parses_and_skips_junk(self):
        text = "# comment\n\npm-a:100000:65536\nbroken\npm-b:x:y\npm-c:165536:65536\n"
        self.assertEqual(
            ctl.parse_subid_file(text),
            [("pm-a", 100000, 65536), ("pm-c", 165536, 65536)],
        )

    def test_next_start_is_above_every_allocation(self):
        subuid = "pm-a:100000:65536\n"
        subgid = "pm-a:100000:65536\npm-b:165536:65536\n"
        self.assertEqual(ctl.next_subid_start([subuid, subgid], 100000, 65536), 231072)

    def test_next_start_on_empty_host(self):
        self.assertEqual(ctl.next_subid_start(["", ""], 100000, 65536), 100000)

    def test_next_start_aligns_unaligned_ranges(self):
        # A hand-rolled entry that does not sit on a 65536 boundary must not
        # push the next range into a partial overlap.
        self.assertEqual(
            ctl.next_subid_start(["someone:100000:1000\n", ""], 100000, 65536), 165536
        )


class SecretPathTests(unittest.TestCase):
    def test_ssh_config_pins_the_deploy_key(self):
        text = ctl.ssh_config_text("/home/pm-demo/.ssh/deploy_key")
        self.assertIn("IdentityFile /home/pm-demo/.ssh/deploy_key", text)
        self.assertIn("IdentitiesOnly yes", text)
        self.assertIn("BatchMode yes", text)

    def test_git_ssh_command_is_batch_and_key_pinned(self):
        cmd = ctl.git_ssh_command("/k/deploy_key", "/k/known_hosts")
        self.assertIn("-i '/k/deploy_key'", cmd)
        self.assertIn("IdentitiesOnly=yes", cmd)
        self.assertIn("BatchMode=yes", cmd)

    def test_git_env_never_prompts(self):
        env = ctl.git_env(fake_passwd())
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(env["HOME"], "/home/pm-demo")
        self.assertEqual(env["DOCKER_HOST"], "unix:///run/user/1200/docker.sock")

    def test_auth_failure_detection(self):
        failures = [
            "git@github.com: Permission denied (publickey).",
            "ERROR: Repository not found.",
            "fatal: Authentication failed for 'https://example.com/x.git'",
            "could not read Username for 'https://example.com'",
            "Please make sure you have the correct access rights",
        ]
        for text in failures:
            self.assertTrue(ctl.is_auth_failure(text), text)
        self.assertFalse(ctl.is_auth_failure("fatal: unable to access: Could not resolve host"))


class RunnerUnitTests(unittest.TestCase):
    def test_socket_lives_in_a_per_project_directory(self):
        cfg = default_config()
        self.assertEqual(ctl.runner_socket_path(cfg, "demo"), "/srv/pm/runners/demo/control.sock")

    def test_unit_wires_socket_secrets_and_daemon(self):
        cfg = default_config()
        unit = ctl.render_runner_unit(cfg, "demo", fake_passwd(), "/home/pm-demo/work/repo")
        self.assertIn("Environment=PM_PROJECT=demo", unit)
        self.assertIn("Environment=PM_RUNNER_SOCKET=/srv/pm/runners/demo/control.sock", unit)
        self.assertIn("Environment=PM_REPO_DIR=/home/pm-demo/work/repo", unit)
        self.assertIn("Environment=PM_DEPLOY_KEY=/home/pm-demo/.ssh/deploy_key", unit)
        self.assertIn("Environment=DOCKER_HOST=unix:///run/user/1200/docker.sock", unit)
        self.assertIn("ExecStart=/usr/bin/node /srv/pm/app/runner/dist/index.js", unit)
        # Group-writable socket + the setgid runners dir is what lets pm connect.
        self.assertIn("UMask=0007", unit)
        self.assertIn("Requires=docker.service", unit)


class ConfigTests(unittest.TestCase):
    def test_defaults_when_file_is_absent(self):
        cfg = ctl.load_config("/nonexistent/pm-projectctl.conf")
        self.assertEqual(cfg.socket_path, "/srv/pm/projectctl.sock")
        self.assertEqual(cfg.pm_group, "pm")
        self.assertEqual(cfg.user_for("demo"), "pm-demo")

    def _write(self, payload: str) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".conf", delete=False)
        handle.write(payload)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_overrides_are_applied(self):
        path = self._write(json.dumps({"pm_group": "pmx", "wait_timeout": 5}))
        cfg = ctl.load_config(path)
        self.assertEqual(cfg.pm_group, "pmx")
        self.assertEqual(cfg.wait_timeout, 5)
        self.assertEqual(cfg.runners_dir, ctl.DEFAULT_CONFIG["runners_dir"])

    def test_rejects_unknown_keys_and_bad_runner_exec(self):
        for payload in ('{"nope": 1}', '{"runner_exec": []}', '{"runner_exec": "node x.js"}'):
            with self.assertRaises(ctl.PmError) as caught:
                ctl.load_config(self._write(payload))
            self.assertEqual(caught.exception.code, "bad_config")

    def test_rejects_malformed_file(self):
        with self.assertRaises(ctl.PmError):
            ctl.load_config(self._write("not json"))


class RequestHandlingTests(unittest.TestCase):
    def setUp(self):
        self.cfg = default_config()
        self.events = []

    def write(self, event):
        self.events.append(event)

    def dispatch(self, payload, verbs):
        ctl.handle_request(self.cfg, payload, self.write, verbs)

    def test_success_streams_progress_then_result(self):
        def handler(args, cfg, emit):
            emit("one", "first")
            emit("two", "second")
            return {"name": args["name"]}

        self.dispatch(b'{"verb":"demo","args":{"name":"x"}}', {"demo": handler})
        self.assertEqual([event["type"] for event in self.events], ["progress", "progress", "result"])
        self.assertEqual(self.events[0]["step"], "one")
        self.assertEqual(self.events[-1], {"type": "result", "ok": True, "data": {"name": "x"}})

    def test_pm_error_becomes_a_coded_error_event(self):
        def handler(args, cfg, emit):
            raise ctl.PmError("invalid_name", "bad")

        self.dispatch(b'{"verb":"demo"}', {"demo": handler})
        self.assertEqual(self.events, [{"type": "error", "code": "invalid_name", "message": "bad"}])

    def test_unexpected_exception_is_contained(self):
        def handler(args, cfg, emit):
            raise RuntimeError("boom")

        self.dispatch(b'{"verb":"demo"}', {"demo": handler})
        self.assertEqual(self.events[-1]["code"], "internal")

    def test_bad_requests(self):
        cases = {
            b"not json": "bad_request",
            b"[1,2]": "bad_request",
            b'{"verb":"nope"}': "unknown_verb",
            b'{"verb":123}': "unknown_verb",
            b'{"verb":"demo","args":[]}': "bad_request",
        }
        for payload, code in cases.items():
            self.events = []
            self.dispatch(payload, {"demo": lambda a, c, e: {}})
            self.assertEqual(self.events[-1]["code"], code, payload)

    def test_real_verbs_validate_before_touching_the_host(self):
        # Verb validation must reject bad input before any privileged step, so
        # these are safe (and meaningful) to assert without root.
        for verb, args, code in (
            ("create", {"name": "BAD", "gitUrl": "https://x/y.git"}, "invalid_name"),
            ("create", {"name": "ok", "gitUrl": "ext::sh -c id"}, "invalid_url"),
            ("start", {"name": "../etc"}, "invalid_name"),
            ("stop", {}, "invalid_name"),
            ("delete", {"name": "BAD"}, "invalid_name"),
            ("set-credential", {"name": "BAD", "key": "claude", "value": "x"}, "invalid_name"),
            ("set-credential", {"name": "ok", "key": "BAD KEY", "value": "x"}, "invalid_key"),
            ("set-credential", {"name": "ok", "key": "claude"}, "invalid_value"),
        ):
            self.events = []
            self.dispatch(json.dumps({"verb": verb, "args": args}).encode(), None)
            self.assertEqual(self.events[-1]["type"], "error")
            self.assertEqual(self.events[-1]["code"], code, (verb, args))


class SocketRoundTripTests(unittest.TestCase):
    """The wire protocol over a real AF_UNIX socket, as pm speaks it."""

    def setUp(self):
        self.cfg = default_config()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: os.path.exists(self.path) and os.unlink(self.path))
        self.path = os.path.join(self.tmp, "control.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(4)
        self.addCleanup(self.server.close)

    def serve_one(self, verbs):
        def loop():
            conn, _ = self.server.accept()
            ctl.serve_connection(self.cfg, conn, verbs)

        thread = threading.Thread(target=loop, daemon=True)
        thread.start()
        return thread

    def request(self, payload: bytes):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(10)
        client.connect(self.path)
        with client:
            client.sendall(payload)
            events = []
            with client.makefile("rb") as reader:
                for line in reader:
                    if line.strip():
                        events.append(json.loads(line))
            return events

    def test_progress_and_result_arrive_as_ndjson(self):
        seen = {}

        def handler(args, cfg, emit):
            seen.update(args)
            emit("work", "doing it")
            return {"ok": "yes"}

        thread = self.serve_one({"demo": handler})
        events = self.request(b'{"verb":"demo","args":{"name":"demo"}}\n')
        thread.join(10)
        self.assertEqual(seen, {"name": "demo"})
        self.assertEqual(
            events,
            [
                {"type": "progress", "step": "work", "message": "doing it"},
                {"type": "result", "ok": True, "data": {"ok": "yes"}},
            ],
        )

    def test_empty_request_is_rejected(self):
        thread = self.serve_one({})
        events = self.request(b"\n")
        thread.join(10)
        self.assertEqual(events[-1]["code"], "bad_request")


class CliTests(unittest.TestCase):
    def test_create_maps_positionals_onto_verb_args(self):
        opts = ctl.build_parser().parse_args(["create", "demo", "git@github.com:a/b.git"])
        self.assertEqual(opts.command, "create")
        self.assertEqual(opts.name, "demo")
        self.assertEqual(opts.git_url, "git@github.com:a/b.git")

    def test_status_name_is_optional(self):
        self.assertIsNone(ctl.build_parser().parse_args(["status"]).name)

    def test_remote_flag_and_socket_override(self):
        opts = ctl.build_parser().parse_args(["--socket", "/tmp/x.sock", "start", "demo"])
        self.assertEqual(opts.socket, "/tmp/x.sock")

    def test_a_verb_is_required(self):
        with self.assertRaises(SystemExit):
            ctl.build_parser().parse_args([])

    def test_delete_purge_flag_defaults_off(self):
        opts = ctl.build_parser().parse_args(["delete", "demo"])
        self.assertEqual(opts.name, "demo")
        self.assertFalse(opts.purge)
        opts = ctl.build_parser().parse_args(["delete", "demo", "--purge"])
        self.assertTrue(opts.purge)

    def test_set_credential_maps_positionals(self):
        opts = ctl.build_parser().parse_args(["set-credential", "demo", "claude"])
        self.assertEqual(opts.name, "demo")
        self.assertEqual(opts.key, "claude")

    def test_set_credential_reads_value_from_stdin_not_argv(self):
        captured = {}

        def fake_run_local(cfg, verb, args):
            captured.update(args)
            return 0

        with mock.patch.object(ctl, "run_local", fake_run_local), mock.patch(
            "sys.stdin", io.StringIO("sk-secret-token\n")
        ):
            exit_code = ctl.main(["set-credential", "demo", "claude"])
        self.assertEqual(exit_code, 0)
        self.assertEqual(captured, {"name": "demo", "key": "claude", "value": "sk-secret-token"})


if __name__ == "__main__":
    unittest.main()
