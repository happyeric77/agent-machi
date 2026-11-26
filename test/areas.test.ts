import assert from "node:assert/strict";
import test from "node:test";
import { AREA_SPOTS, pickAreaSpot, spotById, type AreaName } from "../src/areas.ts";
import { planRoute } from "../src/planner.ts";
import { loadGraph } from "../src/town/graph/graph.ts";

const AREAS: AreaName[] = ["beach", "station", "worksite"];
const MIN_SPACING = 0.5;

test("every area holds a cap-sized set of unique, well-separated spots", () => {
  assert.equal(new Set(AREA_SPOTS.map((spot) => spot.id)).size, AREA_SPOTS.length);
  for (const area of AREAS) {
    const spots = AREA_SPOTS.filter((spot) => spot.area === area);
    assert.ok(spots.length >= 24, `${area} has ${spots.length} spots`);
    for (let i = 0; i < spots.length; i += 1) {
      for (let j = i + 1; j < spots.length; j += 1) {
        const gap = Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z);
        assert.ok(gap >= MIN_SPACING, `${spots[i].id} and ${spots[j].id} are ${gap.toFixed(3)} apart`);
      }
    }
  }
});

test("every spot names an entrance and sits on a walkable surface", () => {
  for (const spot of AREA_SPOTS) {
    assert.ok(spot.entrance.length > 0, spot.id);
    assert.ok(spot.y >= 0.5 && spot.y <= 0.63, `${spot.id} surface ${spot.y}`);
  }
});

test("every spot's entrance node is walkable and actually connects to it", () => {
  const graph = loadGraph();
  for (const spot of AREA_SPOTS) {
    const node = graph.nodes.get(spot.entrance);
    assert.ok(node, `${spot.id} entrance ${spot.entrance} is not a graph node`);
    assert.equal(node.runtimeCollisionStatus, "FINITE_SAMPLE_PASS", `${spot.entrance} is not walkable`);
    // The coastal band is only reachable along the path, so its far spots walk
    // in from CJ-C; 3.9 is the longest authored approach plus slack.
    assert.ok(
      Math.hypot(node.worldX - spot.x, node.worldZ - spot.z) <= 3.9,
      `${spot.id} sits ${Math.hypot(node.worldX - spot.x, node.worldZ - spot.z).toFixed(2)} from ${spot.entrance}`,
    );
    assert.ok(planRoute(graph, "S", spot.entrance), `no route from S to ${spot.entrance}`);
  }
});

test("pickAreaSpot fills the area before reusing a spot", () => {
  const area: AreaName = "station";
  const spots = AREA_SPOTS.filter((spot) => spot.area === area);
  const taken = new Set<string>();
  const assigned: string[] = [];
  for (let index = 0; index < spots.length; index += 1) {
    const spot = pickAreaSpot(area, index, taken);
    assert.ok(spot, `spot ${index}`);
    assert.equal(taken.has(spot.id), false);
    taken.add(spot.id);
    assigned.push(spot.id);
  }
  assert.equal(new Set(assigned).size, spots.length);
  assert.equal(pickAreaSpot(area, 0, taken), null);
});

test("pickAreaSpot spreads neighbours by seed instead of clustering at spot one", () => {
  const first = pickAreaSpot("beach", 0, new Set());
  const second = pickAreaSpot("beach", 7, new Set());
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  assert.equal(spotById(first.id)?.id, first.id);
});
