import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontMatter, stringifyFrontMatter } from "./frontmatter.js";

test("stringifyFrontMatter then parseFrontMatter round-trips data and body", () => {
  const data = { id: 12, title: "Promo codes", branch: null };
  // stringifyFrontMatter normalizes to exactly one trailing newline, so the
  // input already carries one for an exact round-trip.
  const body = "# Promo codes\n\nAdd a promo code field to checkout.\n";
  const doc = stringifyFrontMatter(data, body);
  assert.match(doc, /^---\n/);

  const parsed = parseFrontMatter<typeof data>(doc);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, body);
});

test("parseFrontMatter tolerates a document with no front matter", () => {
  const parsed = parseFrontMatter("just a plain markdown body");
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, "just a plain markdown body");
});
