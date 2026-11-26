import assert from "node:assert/strict";
import test from "node:test";
import { MODULES, PALETTE, lookFor } from "../src/characters.ts";

test("the same resident id always gets the same module and colours", () => {
  for (const paneId of ["ext:ci:1", "fake:p1", "w7:p2", "ext:opencode:mac-mini-ses_abc"]) {
    assert.deepEqual(lookFor(paneId), lookFor(paneId));
  }
});

test("ids from every bridge mode get a look, and different ids differ somewhere", () => {
  const ids = ["ext:ci:1", "fake:p1", "w7:p2"];
  for (const paneId of ids) {
    const look = lookFor(paneId);
    assert.ok(MODULES.includes(look.module), paneId);
    assert.ok(PALETTE.includes(look.head), paneId);
    assert.ok(PALETTE.includes(look.torso), paneId);
    assert.ok(PALETTE.includes(look.legs), paneId);
    assert.notEqual(look.head.hex, look.torso.hex, `${paneId} hat must read against the tunic`);
  }
  const combinatorics = new Set(ids.map((id) => {
    const look = lookFor(id);
    return `${look.module}|${look.head.name}|${look.torso.name}|${look.legs.name}`;
  }));
  assert.ok(combinatorics.size >= 3);
});

test("a cap-sized resident set stays visually varied", () => {
  const looks = Array.from({ length: 24 }, (_, index) => lookFor(`fake:p${index + 1}`));
  assert.ok(new Set(looks.map((look) => look.module)).size >= 4);
  assert.ok(new Set(looks.map((look) => look.torso.name)).size >= 6);
  const pairs = new Set(looks.map((look) => `${look.module}|${look.torso.name}`));
  assert.ok(pairs.size >= 18, `${pairs.size} distinct module/torso pairs`);
});
