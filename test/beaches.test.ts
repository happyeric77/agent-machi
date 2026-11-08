import assert from "node:assert/strict";
import test from "node:test";
import { BEACH_SPOTS } from "../src/beaches.ts";

test("beach spots are unique and split evenly between both entrances", () => {
  assert.equal(BEACH_SPOTS.length, 6);
  assert.equal(new Set(BEACH_SPOTS.map((spot) => spot.id)).size, 6);
  assert.equal(new Set(BEACH_SPOTS.map((spot) => `${spot.x},${spot.z}`)).size, 6);
  assert.equal(BEACH_SPOTS.filter((spot) => spot.entrance === "F-W").length, 3);
  assert.equal(BEACH_SPOTS.filter((spot) => spot.entrance === "F-E").length, 3);
});

test("beach spots sit on the dry sand band near the surf", () => {
  for (const spot of BEACH_SPOTS) {
    assert.ok(spot.z >= 6.5 && spot.z <= 6.9, `${spot.id} should be near the waterline`);
    const side = spot.entrance === "F-W" ? -1 : 1;
    assert.ok(spot.x * side > 1.5, `${spot.id} should be spread along its beach side`);
  }
});
