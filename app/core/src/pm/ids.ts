const DEFAULT_ID_WIDTH = 4;

export function formatId(n: number, width = DEFAULT_ID_WIDTH): string {
  return String(n).padStart(width, "0");
}

const LEADING_ID_RE = /^0*(\d+)(?:[-.]|$)/;

/** Extracts the leading numeric id from a name like "0012-promo-codes" or "0003.md". */
export function parseLeadingId(name: string): number | null {
  const match = LEADING_ID_RE.exec(name);
  return match ? Number(match[1]) : null;
}

/** Smallest id greater than every id found among `names`, starting from 1. */
export function nextId(names: Iterable<string>): number {
  let max = 0;
  for (const name of names) {
    const id = parseLeadingId(name);
    if (id !== null && id > max) max = id;
  }
  return max + 1;
}
