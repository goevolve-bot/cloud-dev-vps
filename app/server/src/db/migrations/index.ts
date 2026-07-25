import * as m0001Init from "./0001_init.js";
import * as m0002ProviderCreds from "./0002_provider_creds.js";
import * as m0003ProviderCredSecret from "./0003_provider_cred_secret.js";
import * as m0004ProjectTimeouts from "./0004_project_timeouts.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

const modules = [m0001Init, m0002ProviderCreds, m0003ProviderCredSecret, m0004ProjectTimeouts];

export const migrations: Migration[] = modules
  .map((m) => ({ version: m.version, name: m.name, up: m.up, down: m.down }))
  .sort((a, b) => a.version - b.version);
