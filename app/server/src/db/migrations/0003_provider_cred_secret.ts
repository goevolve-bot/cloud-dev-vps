// Migration 0003: keep the provider key itself, not only its mask.
//
// The plan wants a provider credential seeded into *every* project user,
// including ones created after the key was entered — and pm-projectctl is
// write-only (`set-credential` has no `get`), so there is nowhere else to read
// it back from at create time. That means pm has to retain the value.
//
// This is a smaller concession than it looks: pm already holds the
// projectctl socket, and anything that can talk to that socket can write an
// arbitrary credential into any project user. The DB lives on the host under
// /srv/pm/data, owned by the `pm` user. The isolation this system protects is
// *project against project*, and that is unchanged — a project user still only
// ever sees its own ~/.pm-creds.
export const version = 3;
export const name = "provider_cred_secret";

export const up = `
ALTER TABLE provider_creds ADD COLUMN secret TEXT;
`;

export const down = `
ALTER TABLE provider_creds DROP COLUMN secret;
`;
