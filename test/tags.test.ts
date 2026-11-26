import assert from "node:assert/strict";
import test from "node:test";
import { claimsHomeFor, tagVisibleFor } from "../src/director.ts";

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

test("a resident at its work spot keeps it through working -> done", () => {
  // A vacancy opening mid-task must not pull a houseless resident off its
  // spot: the green check belongs over the resident, not on a doorstep.
  assert.equal(claimsHomeFor("done", false, true), false, "done at the work spot stays");
  assert.equal(claimsHomeFor("working", false, true), false, "a new task in place stays too");
  // Idle/blocked never want a house.
  assert.equal(claimsHomeFor("idle", false, false), false, "idle takes no house");
  assert.equal(claimsHomeFor("blocked", false, false), false, "blocked takes no house");
  // A resident with a house always uses it, and one starting a task from
  // anywhere else still claims a vacancy.
  assert.equal(claimsHomeFor("working", true, true), true, "the housed go to their office");
  assert.equal(claimsHomeFor("working", false, false), true, "a vacancy is taken on the next task");
});
