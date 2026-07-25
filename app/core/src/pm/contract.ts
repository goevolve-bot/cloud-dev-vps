import { join } from "node:path";
import { stat, readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface ContractState {
  readonly hasDockerfile: boolean;
  readonly composeFileExists: boolean;
  readonly mainServiceExists: boolean;
  readonly mainServiceHasHealthcheck: boolean;
  readonly hasTest: boolean;
  readonly hasE2E: boolean;
  readonly hasUI: boolean;
  readonly isCompliant: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The main service is the first compose service that publishes ports — the
 * one actually serving traffic, as opposed to one-shot services like `test`
 * or `e2e` that run once and exit. Keying off the project name broke as soon
 * as a repo named its compose service `app` or `web`: that service could
 * never be "the main service" under the old rule, so a compliant repo could
 * never be marked compliant.
 */
function findMainServiceName(services: Record<string, unknown>): string | null {
  for (const [name, def] of Object.entries(services)) {
    if (!def || typeof def !== "object") continue;
    const ports = (def as { ports?: unknown }).ports;
    if (Array.isArray(ports) && ports.length > 0) return name;
  }
  return null;
}

export async function detectContract(
  repoDir: string | null,
  // No longer used to find the main service (see findMainServiceName above),
  // but kept in the signature — callers (server/src/indexer/index.ts) still
  // pass it, and it documents which project this contract check is for.
  projectName: string,
): Promise<ContractState> {
  void projectName;
  const defaultState: ContractState = {
    hasDockerfile: false,
    composeFileExists: false,
    mainServiceExists: false,
    mainServiceHasHealthcheck: false,
    hasTest: false,
    hasE2E: false,
    hasUI: false,
    isCompliant: false,
  };

  if (!repoDir) {
    return defaultState;
  }

  const hasDockerfile = await fileExists(join(repoDir, "Dockerfile"));

  let composePath = "";
  for (const name of ["compose.yaml", "docker-compose.yml"]) {
    const p = join(repoDir, name);
    if (await fileExists(p)) {
      composePath = p;
      break;
    }
  }

  if (!composePath) {
    return { ...defaultState, hasDockerfile };
  }

  try {
    const content = await readFile(composePath, "utf8");
    const doc = parse(content);
    if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
      return { ...defaultState, hasDockerfile, composeFileExists: true };
    }

    const services = doc.services as Record<string, unknown>;
    const mainServiceName = findMainServiceName(services);
    const mainServiceExists = mainServiceName !== null;
    let mainServiceHasHealthcheck = false;
    if (mainServiceName) {
      const main = services[mainServiceName];
      if (main && typeof main === "object" && (main as { healthcheck?: unknown }).healthcheck) {
        mainServiceHasHealthcheck = true;
      }
    }

    const hasTest = Object.prototype.hasOwnProperty.call(services, "test");
    const hasE2E = Object.prototype.hasOwnProperty.call(services, "e2e");
    const hasUI = hasE2E;

    return {
      hasDockerfile,
      composeFileExists: true,
      mainServiceExists,
      mainServiceHasHealthcheck,
      hasTest,
      hasE2E,
      hasUI,
      // Contract item 1 (Dockerfile) and the plan's stated compliance bar
      // ("the main service must define a healthcheck") together. A repo
      // whose service isn't named after the project is no longer penalized —
      // only whether *some* service actually serves traffic and has a
      // healthcheck matters.
      isCompliant: hasDockerfile && mainServiceHasHealthcheck,
    };
  } catch {
    return { ...defaultState, hasDockerfile, composeFileExists: true };
  }
}
