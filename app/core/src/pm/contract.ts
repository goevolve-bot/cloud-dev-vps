import { join } from "node:path";
import { stat, readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface ContractState {
  readonly composeFileExists: boolean;
  readonly mainServiceExists: boolean;
  readonly mainServiceHasHealthcheck: boolean;
  readonly hasTest: boolean;
  readonly hasE2E: boolean;
  readonly hasUI: boolean;
  readonly isCompliant: boolean;
}

export async function detectContract(
  repoDir: string | null,
  projectName: string,
): Promise<ContractState> {
  const defaultState: ContractState = {
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

  let composePath = "";
  for (const name of ["compose.yaml", "docker-compose.yml"]) {
    const p = join(repoDir, name);
    try {
      await stat(p);
      composePath = p;
      break;
    } catch {
      // try next
    }
  }

  if (!composePath) {
    return defaultState;
  }

  try {
    const content = await readFile(composePath, "utf8");
    const doc = parse(content);
    if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
      return {
        ...defaultState,
        composeFileExists: true,
      };
    }

    const services = doc.services;
    const mainServiceExists = Object.prototype.hasOwnProperty.call(services, projectName);
    let mainServiceHasHealthcheck = false;
    if (mainServiceExists) {
      const main = services[projectName];
      if (main && typeof main === "object" && main.healthcheck) {
        mainServiceHasHealthcheck = true;
      }
    }

    const hasTest = Object.prototype.hasOwnProperty.call(services, "test");
    const hasE2E = Object.prototype.hasOwnProperty.call(services, "e2e");
    const hasUI = hasE2E;

    return {
      composeFileExists: true,
      mainServiceExists,
      mainServiceHasHealthcheck,
      hasTest,
      hasE2E,
      hasUI,
      isCompliant: mainServiceExists && mainServiceHasHealthcheck,
    };
  } catch {
    return {
      ...defaultState,
      composeFileExists: true,
    };
  }
}
