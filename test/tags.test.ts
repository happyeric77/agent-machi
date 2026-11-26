import assert from "node:assert/strict";
import test from "node:test";
import { tagVisibleFor } from "../src/director.ts";

test("name tags are drawn in a small town and withheld at the cap", () => {
  // A tag is 1.75 world units wide and area spots sit 0.55 apart, so a full
  // town can only draw them as one black band over the characters.
  assert.equal(tagVisibleFor(6, false), true, "the old cast keeps its tags");
  assert.equal(tagVisibleFor(8, false), true, "the last size that still fits");
  assert.equal(tagVisibleFor(9, false), false, "one more and they collide");
  assert.equal(tagVisibleFor(24, false), false, "the cap has no room for tags");
  // Picking a resident from the Roster still names it.
  assert.equal(tagVisibleFor(24, true), true, "a highlighted resident is named");
});
