// Migration 0002: provider_creds table for masked credential status (T36)
export const version = 2;
export const name = "provider_creds";

export const up = `
CREATE TABLE provider_creds (
  provider      TEXT NOT NULL PRIMARY KEY,
  masked_key    TEXT NOT NULL,
  connected_at  TEXT NOT NULL,
  account       TEXT
);
`;

export const down = `
DROP TABLE IF EXISTS provider_creds;
`;
