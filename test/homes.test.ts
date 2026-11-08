import assert from "node:assert/strict";
import test from "node:test";
import { loadGraph } from "../src/town/graph/graph.ts";
import { HOME_SPOTS } from "../src/homes.ts";

test("every home node has an off-road doorstep and a sign anchor", () => {
  const graph = loadGraph();
  const homes = ["P4", "P2", "P1", "P3", "P5", "R1", "R2"];

  assert.equal(Object.keys(HOME_SPOTS).length, homes.length);
  for (const nodeId of homes) {
    const spot = HOME_SPOTS[nodeId];
    assert.ok(spot, `missing doorstep for ${nodeId}`);
    assert.equal(spot.node, nodeId);

    const node = graph.nodes.get(nodeId);
    assert.ok(node, `missing graph node ${nodeId}`);

    const doorstepDistance = Math.hypot(spot.x - node.worldX, spot.z - node.worldZ);
    assert.ok(doorstepDistance > 0.2, `${nodeId} doorstep still on the road centre`);
    assert.ok(doorstepDistance < 2.0, `${nodeId} doorstep is too far from its node`);

    assert.ok(Number.isFinite(spot.signX) && Number.isFinite(spot.signZ));
    assert.ok(Number.isFinite(spot.signYaw));
    assert.ok(
      Math.hypot(spot.signX - spot.x, spot.signZ - spot.z) > 0.1,
      `${nodeId} sign overlaps the doorstep`,
    );
  }
});
