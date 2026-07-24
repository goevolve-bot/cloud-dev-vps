import * as m0001Init from "./0001_init.js";
import * as m0002ProviderCreds from "./0002_provider_creds.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

const modules = [m0001Init, m0002ProviderCreds];

export const migrations: Migration[] = modules
  .map((m) => ({ version: m.version, name: m.name, up: m.up, down: m.down }))
  .sort((a, b) => a.version - b.version);
