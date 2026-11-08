// Slim the town graph JSON. Repeatable: by default it reads the original
// pre-refactor payload from git commit 00edc46, never from the slimmed output.
// Usage: node tools/slim-town-graph.mjs [source-dir] [target-dir]
//        GRAPH_SOURCE_COMMIT=<sha> node tools/slim-town-graph.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { polylineLength, simplifyLine } from "./graph-lib.mjs";

const NODE_FIELDS = [
  "id",
  "name",
  "worldX",
  "worldZ",
  "type",
  "placementStatus",
  "runtimeCollisionStatus",
];
const EDGE_FIELDS = [
  "id",
  "from",
  "to",
  "centerline",
  "worldLength",
  "bidirectional",
  "runtimeCollisionStatus",
  "ownerApprovalStatus",
];
const TOLERANCE = 0.02;
const MAX_LENGTH_ERROR = 0.01;
const sourceCommit = process.env.GRAPH_SOURCE_COMMIT ?? "00edc46";
const sourceDir = process.argv[2];
const targetDir = process.argv[3] ?? "src/town/graph/data";

function readSource(name) {
  if (sourceDir) return readFileSync(join(sourceDir, name), "utf8");
  return execFileSync("git", ["show", `${sourceCommit}:src/station-to-sea/game/data/${name}`], {
    encoding: "utf8",
  });
}

const nodes = JSON.parse(readSource("graph-nodes.json"));
const edges = JSON.parse(readSource("graph-edges.json"));

const pick = (object, fields) => Object.fromEntries(fields.map((field) => [field, object[field]]));
const slimNodes = nodes.map((node) => pick(node, NODE_FIELDS));
const fallbacks = [];
let originalPoints = 0;
let simplifiedPoints = 0;

const slimEdges = edges.map((edge) => {
  originalPoints += edge.centerline.length;
  let tolerance = TOLERANCE;
  let centerline = simplifyLine(edge.centerline, tolerance);
  const originalLength = polylineLength(edge.centerline);
  let simplifiedLength = polylineLength(centerline);
  let error = originalLength > 0 ? Math.abs(simplifiedLength - originalLength) / originalLength : 0;

  // Never loosen the 1% gate: retry with a tighter tolerance, then keep the
  // original points if even that cannot meet it.
  while (error >= MAX_LENGTH_ERROR && tolerance > 0.0001) {
    tolerance /= 2;
    centerline = simplifyLine(edge.centerline, tolerance);
    simplifiedLength = polylineLength(centerline);
    error = originalLength > 0 ? Math.abs(simplifiedLength - originalLength) / originalLength : 0;
  }
  if (error >= MAX_LENGTH_ERROR) {
    centerline = edge.centerline.map((point) => [...point]);
    simplifiedLength = originalLength;
    error = 0;
    fallbacks.push({ id: edge.id, reason: "kept original points", tolerance });
  } else if (tolerance !== TOLERANCE) {
    fallbacks.push({ id: edge.id, reason: "tighter tolerance", tolerance, error });
  }

  simplifiedPoints += centerline.length;
  return { ...pick(edge, EDGE_FIELDS), centerline };
});

writeFileSync(join(targetDir, "graph-nodes.json"), `${JSON.stringify(slimNodes, null, 1)}\n`);
writeFileSync(join(targetDir, "graph-edges.json"), `${JSON.stringify(slimEdges, null, 1)}\n`);

console.log(`source: ${sourceDir ?? `git ${sourceCommit}:src/station-to-sea/game/data`}`);
console.log(`nodes: ${slimNodes.length}, edges: ${slimEdges.length}`);
console.log(`centerline points: ${originalPoints} -> ${simplifiedPoints}`);
if (fallbacks.length === 0) {
  console.log(`all edges within ${MAX_LENGTH_ERROR * 100}% at tolerance ${TOLERANCE}`);
} else {
  console.log("tolerance exceptions:");
  for (const fallback of fallbacks) console.log(`  ${fallback.id}: ${JSON.stringify(fallback)}`);
}
