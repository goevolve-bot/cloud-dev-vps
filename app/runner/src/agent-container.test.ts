import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDockerArgs } from "./handlers.js";

function argsFor(overrides: Partial<Parameters<typeof agentDockerArgs>[0]> = {}) {
  return agentDockerArgs({
    containerName: "pm-run-1",
    workspaceDir: "/home/pm-smoke/work/pm-smoke",
    cmd: ["claude", "-p", "do the thing"],
    ...overrides,
  });
}

test("agent container declares IS_SANDBOX so the CLI's root check passes", () => {
  // Both CLIs abort on `--dangerously-skip-permissions` as euid 0, and the
  // agent must be container root to write its rootless-mapped workspace.
  // Losing this env turns every agent run into an instant exit-1 whose only
  // symptom is one line on stderr — the failure this test exists to catch.
  const args = argsFor();
  const at = args.indexOf("IS_SANDBOX=1");
  assert.notEqual(at, -1, "IS_SANDBOX=1 must be passed to the agent container");
  assert.equal(args[at - 1], "-e", "IS_SANDBOX=1 must be introduced by -e");
  assert.ok(at < args.indexOf("pm-agent"), "env flags must precede the image name");
});

test("agent container is disposable and gets only the workspace, socket and key", () => {
  const args = argsFor();
  assert.ok(args.includes("--rm"));
  const mounts = args.filter((_, i) => args[i - 1] === "-v");
  assert.ok(mounts.some((m) => m.endsWith(":/workspace")));
  assert.ok(mounts.some((m) => m.endsWith(":/var/run/docker.sock")));
  assert.ok(mounts.some((m) => m.endsWith(":/root/.ssh:ro")));
});

test("a worktree's git common dir is mounted at the path its .git file names", () => {
  // A linked worktree's .git is `gitdir: <repo>/.git/worktrees/<name>` — an
  // absolute host path. Mount it anywhere else and every git command in the
  // agent container fails with "not a git repository", which is how the
  // implement phase silently stopped committing.
  const gitCommonDir = "/home/pm-smoke/work/pm-smoke/.git";
  const args = argsFor({ gitCommonDir });
  const mounts = args.filter((_, i) => args[i - 1] === "-v");
  assert.ok(
    mounts.includes(`${gitCommonDir}:${gitCommonDir}`),
    "the common dir must be mounted at its own absolute path, unchanged",
  );
});

test("clone-based phases mount no git common dir", () => {
  // verify and review clone from origin, so their checkout is self-contained.
  const args = argsFor({ gitCommonDir: null });
  assert.ok(!args.some((a) => a.includes(".git:")));
});

test("no credential value ever reaches the agent container's argv", () => {
  const args = argsFor();
  // The shim reads the mounted files inside the container; -e carries only
  // the sandbox assertion, never a secret.
  const envValues = args.filter((_, i) => args[i - 1] === "-e");
  assert.deepEqual(envValues, ["IS_SANDBOX=1"]);
});

test("the provider command is appended after the credential shim", () => {
  const args = argsFor({ cmd: ["claude", "-p", "hello"] });
  assert.deepEqual(args.slice(-3), ["claude", "-p", "hello"]);
  assert.equal(args[args.length - 4], "pm-agent"); // $0 for the shim's sh -c
});

test("an explicit network is passed through, and omitted when absent", () => {
  const withNet = argsFor({ network: "smoke_default" });
  assert.equal(withNet[withNet.indexOf("--network") + 1], "smoke_default");
  assert.ok(!argsFor({ network: null }).includes("--network"));
});
