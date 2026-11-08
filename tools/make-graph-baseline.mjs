// Build the pre-slimming graph baseline used by test/town-graph.test.ts.
// Usage: node tools/make-graph-baseline.mjs [source-data-dir] [output-file]
// By default the source is the original PR #5 payload read from git commit
// 00edc46, not the current (already slimmed) src/town/graph/data.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allPairs, polylineLength, traversableEdges } from "./graph-lib.mjs";

const sourceDir = process.argv[2];
const outputFile = process.argv[3] ?? "test/fixtures/graph-baseline.json";
const sourceCommit = process.env.GRAPH_SOURCE_COMMIT ?? "00edc46";

function readData(name) {
  if (sourceDir) return readFileSync(join(sourceDir, name), "utf8");
  return execFileSync("git", ["show", `${sourceCommit}:src/station-to-sea/game/data/${name}`], {
    encoding: "utf8",
  });
}

const nodes = JSON.parse(readData("graph-nodes.json"));
const edges = JSON.parse(readData("graph-edges.json"));

const baseline = {
  source: `station-to-sea @ a7f589e7 / agent-machi PR #5 payload (commit ${sourceCommit})`,
  nodeCount: nodes.length,
  edgeCount: edges.length,
  traversableEdgeIds: traversableEdges(edges).map((edge) => edge.id).sort(),
  pairs: allPairs(nodes, edges),
  edgeGeometry: edges.map((edge) => ({
    id: edge.id,
    geometricLength: Number(polylineLength(edge.centerline).toFixed(9)),
    pointCount: edge.centerline.length,
  })),
};

writeFileSync(outputFile, `${JSON.stringify(baseline, null, 1)}\n`);
console.log(
  `baseline: ${baseline.nodeCount} nodes, ${baseline.edgeCount} edges, ` +
    `${baseline.traversableEdgeIds.length} traversable, ${baseline.pairs.length} pairs -> ${outputFile}`,
);
