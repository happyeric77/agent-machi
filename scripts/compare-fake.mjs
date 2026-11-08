#!/usr/bin/env node
// Compare every Node FAKE_SCENARIO against the Go binary's /snapshot and /log.
// Node's event log is hardcoded next to its entry file, so run a temp copy.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const NODE_COPY = path.join(os.tmpdir(), "agent-machi-node-bridge-eq.mjs");
const NODE_LOG = path.join(os.tmpdir(), "events.jsonl");
const GO_LOG = path.join(os.tmpdir(), "agent-machi-go-events.jsonl");
const NODE_PORT = 8801;
const GO_PORT = 8802;

const scenarios = {
  default: 45000,
  flip: 15000,
  blocked2: 33000,
  roster: 38000,
  cast: 33000,
  home4: 7000,
  beach3: 39000,
  castreuse: 38000,
  home: 73000,
  homeblock: 18000,
  signnames: 4000,
  dupe: 5000,
  panelnames: 10000,
};

fs.copyFileSync(path.join(ROOT, "tools/herdr-bridge/index.mjs"), NODE_COPY);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function start(command, args, env) {
  return spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function get(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.json();
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "at" || key === "status_since") output[key] = "<time>";
    else output[key] = normalize(entry);
  }
  return output;
}

// The two bridges schedule same-delay fake events independently, so cross-pane
// order at the same instant is not part of the contract. Keep each pane's own
// event order, then compare panes in a stable order.
function groupLogByPane(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.pane_id ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.keys()].sort().flatMap((key) => groups.get(key));
}

function stop(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
}

let failures = 0;
for (const [scenario, duration] of Object.entries(scenarios)) {
  fs.rmSync(NODE_LOG, { force: true });
  fs.rmSync(GO_LOG, { force: true });
  const node = start(process.execPath, [NODE_COPY], {
    PORT: String(NODE_PORT),
    FAKE: "1",
    FAKE_SCENARIO: scenario,
  });
  const go = start(path.join(ROOT, "agent-machi"), ["--no-open"], {
    PORT: String(GO_PORT),
    FAKE: "1",
    FAKE_SCENARIO: scenario,
    AGENT_MACHI_EVENTS_LOG: GO_LOG,
  });

  try {
    await wait(duration);
    const [nodeSnapshot, goSnapshot, nodeLog, goLog] = await Promise.all([
      get(NODE_PORT, "/snapshot"),
      get(GO_PORT, "/snapshot"),
      get(NODE_PORT, "/log?limit=2000"),
      get(GO_PORT, "/log?limit=2000"),
    ]);
    const sortRows = (rows) => [...rows].sort((a, b) => a.pane_id.localeCompare(b.pane_id));
    const nodeShape = JSON.stringify({ snapshot: normalize(sortRows(nodeSnapshot)), log: normalize(groupLogByPane(nodeLog)) });
    const goShape = JSON.stringify({ snapshot: normalize(sortRows(goSnapshot)), log: normalize(groupLogByPane(goLog)) });
    if (nodeShape === goShape) {
      console.log(`ok ${scenario}`);
    } else {
      failures += 1;
      console.log(`DIFF ${scenario}`);
      for (const [label, left, right] of [
        ["snapshot", JSON.stringify(normalize(sortRows(nodeSnapshot)), null, 2), JSON.stringify(normalize(sortRows(goSnapshot)), null, 2)],
        ["log", JSON.stringify(normalize(groupLogByPane(nodeLog)), null, 2), JSON.stringify(normalize(groupLogByPane(goLog)), null, 2)],
      ]) {
        if (left !== right) {
          console.log(`--- ${label} node`);
          console.log(left);
          console.log(`--- ${label} go`);
          console.log(right);
        }
      }
    }
  } finally {
    stop(node);
    stop(go);
    await wait(200);
  }
}

if (failures > 0) {
  console.error(`${failures} scenario(s) differ`);
  process.exit(1);
}
console.log("all fake scenarios match");
