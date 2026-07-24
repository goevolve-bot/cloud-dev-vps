import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "./slug.js";

test("slugify lower-cases, dashes, and strips punctuation", () => {
  assert.equal(slugify("Promo Codes!"), "promo-codes");
  assert.equal(slugify("  Leading/trailing spaces  "), "leading-trailing-spaces");
  assert.equal(slugify("Café déjà vu"), "cafe-deja-vu");
});

test("slugify falls back to a placeholder for empty input", () => {
  assert.equal(slugify("   "), "untitled");
  assert.equal(slugify("!!!"), "untitled");
});
