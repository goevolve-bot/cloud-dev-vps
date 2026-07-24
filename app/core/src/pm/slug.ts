// Strips combining diacritics (U+0300-U+036F) left behind by NFKD normalization below.
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/** Lower-case, dash-separated slug for a task/ADR folder or file name. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "untitled";
}
