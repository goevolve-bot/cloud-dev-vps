import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { detectContract } from "./contract.js";

async function createTempDir(): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = join(tmpBase, `pm-contract-test-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test("detectContract returns false/default for non-existent repo or empty dir", async () => {
  const resultNull = await detectContract(null, "myproj");
  assert.equal(resultNull.composeFileExists, false);
  assert.equal(resultNull.hasDockerfile, false);
  assert.equal(resultNull.isCompliant, false);

  const tmp = await createTempDir();
  try {
    const resultEmpty = await detectContract(tmp, "myproj");
    assert.equal(resultEmpty.composeFileExists, false);
    assert.equal(resultEmpty.hasDockerfile, false);
    assert.equal(resultEmpty.isCompliant, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectContract parses valid compose.yaml and checks compliance, regardless of service naming", async () => {
  const tmp = await createTempDir();
  try {
    // The service that serves traffic is deliberately NOT named after the
    // project ("myproj") — it's named "app", which the old name-matching
    // rule would have missed entirely.
    const composeContent = `
services:
  app:
    image: node:22
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 10s
  test:
    image: node:22
  e2e:
    image: node:22
`;
    await writeFile(join(tmp, "compose.yaml"), composeContent, "utf8");
    await writeFile(join(tmp, "Dockerfile"), "FROM node:22\n", "utf8");

    const result = await detectContract(tmp, "myproj");
    assert.equal(result.hasDockerfile, true);
    assert.equal(result.composeFileExists, true);
    assert.equal(result.mainServiceExists, true);
    assert.equal(result.mainServiceHasHealthcheck, true);
    assert.equal(result.hasTest, true);
    assert.equal(result.hasE2E, true);
    assert.equal(result.hasUI, true);
    assert.equal(result.isCompliant, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectContract detects non-compliant main service without healthcheck", async () => {
  const tmp = await createTempDir();
  try {
    const composeContent = `
services:
  myproj:
    image: node:22
    ports:
      - "8080:8080"
  test:
    image: node:22
`;
    await writeFile(join(tmp, "docker-compose.yml"), composeContent, "utf8");
    await writeFile(join(tmp, "Dockerfile"), "FROM node:22\n", "utf8");

    const result = await detectContract(tmp, "myproj");
    assert.equal(result.hasDockerfile, true);
    assert.equal(result.composeFileExists, true);
    assert.equal(result.mainServiceExists, true);
    assert.equal(result.mainServiceHasHealthcheck, false);
    assert.equal(result.hasTest, true);
    assert.equal(result.hasE2E, false);
    assert.equal(result.isCompliant, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectContract treats a service with no published ports as not the main service", async () => {
  const tmp = await createTempDir();
  try {
    // A one-shot "test" service is the only entry and publishes no ports —
    // there is no main service, so compliance can't be claimed even though
    // a compose file and a healthcheck-shaped block exist somewhere.
    const composeContent = `
services:
  test:
    image: node:22
    healthcheck:
      test: ["CMD", "true"]
`;
    await writeFile(join(tmp, "compose.yaml"), composeContent, "utf8");
    await writeFile(join(tmp, "Dockerfile"), "FROM node:22\n", "utf8");

    const result = await detectContract(tmp, "myproj");
    assert.equal(result.mainServiceExists, false);
    assert.equal(result.mainServiceHasHealthcheck, false);
    assert.equal(result.isCompliant, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectContract is non-compliant without a Dockerfile even if the main service has a healthcheck", async () => {
  const tmp = await createTempDir();
  try {
    const composeContent = `
services:
  app:
    image: node:22
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "true"]
`;
    await writeFile(join(tmp, "compose.yaml"), composeContent, "utf8");
    // No Dockerfile written.

    const result = await detectContract(tmp, "myproj");
    assert.equal(result.hasDockerfile, false);
    assert.equal(result.mainServiceHasHealthcheck, true);
    assert.equal(result.isCompliant, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
