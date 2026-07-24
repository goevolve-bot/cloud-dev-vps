import assert from "node:assert/strict";
import { test } from "node:test";
import { formatId, nextId, parseLeadingId } from "./ids.js";

test("formatId zero-pads to the requested width", () => {
  assert.equal(formatId(3), "0003");
  assert.equal(formatId(42, 2), "42");
  assert.equal(formatId(12345), "12345");
});

test("parseLeadingId reads the numeric prefix of folder and file names", () => {
  assert.equal(parseLeadingId("0012-promo-codes"), 12);
  assert.equal(parseLeadingId("0003.md"), 3);
  assert.equal(parseLeadingId("README.md"), null);
});

test("nextId picks one past the highest existing id, starting at 1", () => {
  assert.equal(nextId([]), 1);
  assert.equal(nextId(["0001-a", "0003-b", "0002-c"]), 4);
  assert.equal(nextId(["README.md", "0007.md"]), 8);
});
