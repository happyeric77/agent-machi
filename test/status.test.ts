import assert from "node:assert/strict";
import test from "node:test";
import { statusBadge } from "../src/status.ts";

test("statusBadge maps done to a check, blocked to a bang, and nothing else", () => {
  const done = statusBadge("done");
  const blocked = statusBadge("blocked");
  assert.equal(done?.glyph, "check");
  assert.equal(done?.fill, "#6ec08a");
  assert.equal(done?.ink, "#ffffff");
  assert.equal(blocked?.glyph, "!");
  assert.equal(blocked?.fill, "#f2b705");
  assert.equal(blocked?.ink, "#2b2410");
  for (const status of ["idle", "working", "unknown", "elsewhere"]) {
    assert.equal(statusBadge(status), null, status);
  }
});
