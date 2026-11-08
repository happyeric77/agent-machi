// Herdr -> agent-machi bridge. Node standard library only.
//
// Socket -> agent table -> HTTP GET /snapshot + SSE GET /events + JSONL log.
// Every event is stamped by this bridge because the Herdr API has no time
// fields.
//
// Herdr 0.9.5 accepts ONE request per socket connection. A request connection
// is closed after its response. A subscription connection stays open and
// streams event lines, so the bridge keeps one socket for the global
// subscriptions and one per subscribed pane.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const FAKE = process.env.FAKE === "1";
const FAKE_SCENARIO = process.env.FAKE_SCENARIO || "default";
const PORT = Number(process.env.PORT || 8731);
const HOST = "127.0.0.1";
const EVENT_LOG = path.join(HERE, "events.jsonl");

const STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

/** @typedef {"idle"|"working"|"blocked"|"done"|"unknown"} AgentStatus */
/** @typedef {{pane_id:string,name:string|null,agent:string|null,agent_status:AgentStatus,status_since:string,last_change_seq:number}} AgentRow */

/** @type {Map<string, AgentRow>} */
const agents = new Map();
/** @type {Set<import("node:http").ServerResponse>} */
const sseClients = new Set();

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(value) {
  return STATUSES.has(value) ? value : "unknown";
}

function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_SESSION && process.env.HERDR_SESSION !== "default") {
    return path.join(HOME, ".config", "herdr", "sessions", process.env.HERDR_SESSION, "herdr.sock");
  }
  return path.join(HOME, ".config", "herdr", "herdr.sock");
}

function appendEventLog(event) {
  try {
    fs.appendFileSync(EVENT_LOG, JSON.stringify(event) + "\n");
  } catch (error) {
    console.error("[bridge] cannot append events.jsonl:", error.message);
  }
}

/** @param {AgentRow} row */
function publish(row) {
  const event = {
    source: "herdr",
    pane_id: row.pane_id,
    name: row.name,
    agent: row.agent,
    status: row.agent_status,
    at: nowIso(),
  };
  appendEventLog(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(line);
    } catch {
      sseClients.delete(client);
    }
  }
  console.log(`[bridge] ${event.pane_id} ${event.agent ?? "?"} -> ${event.status}`);
}

// ---------------------------------------------------------------------------
// Herdr socket: one-shot requests and long-lived subscriptions

let requestSeq = 0;
let reconcileTimer = null;
let reconciling = false;
let reconcileAgain = false;
let stopping = false;
let retryDelayMs = 500;

/** @type {Map<string, net.Socket>} */
const subscriptions = new Map();

const GLOBAL_SUBSCRIPTIONS = [
  { type: "pane.agent_detected" },
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.exited" },
];

function requestOnce(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    const id = `agent-machi-${++requestSeq}`;
    let buffer = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`Herdr request timed out: ${method}`)), 8000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line);
            if (message.id === id) {
              if (message.error) finish(new Error(message.error.message || message.error.code));
              else finish(null, message.result);
            }
          } catch {
            /* ignore non-JSON while looking for the one response */
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error("Herdr socket closed before response"));
    });
  });
}

function closeSubscription(key) {
  const socket = subscriptions.get(key);
  if (!socket) return;
  subscriptions.delete(key);
  socket.destroy();
}

function closeAllSubscriptions() {
  for (const key of [...subscriptions.keys()]) closeSubscription(key);
}

function openSubscription(key, subscriptionList) {
  if (subscriptions.has(key) || stopping) return;
  const socket = net.createConnection(socketPath());
  subscriptions.set(key, socket);
  let buffer = "";

  socket.setEncoding("utf8");
  socket.on("connect", () => {
    if (process.env.DEBUG) console.log(`[bridge] subscription socket connected: ${key}`);
    socket.write(
      JSON.stringify({
        id: `agent-machi-sub-${++requestSeq}`,
        method: "events.subscribe",
        params: { subscriptions: subscriptionList },
      }) + "\n",
    );
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleSocketLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", (error) => {
    if (subscriptions.get(key) === socket) {
      console.error(`[bridge] subscription ${key} error: ${error.message}`);
      subscriptions.delete(key);
      scheduleReconcile(500);
    }
  });
  socket.on("close", () => {
    if (subscriptions.get(key) === socket) {
      subscriptions.delete(key);
      scheduleReconcile(500);
    }
  });
}

function handleSocketLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error("[bridge] non-JSON socket line:", line.slice(0, 120));
    return;
  }

  if (message.id && message.result) {
    if (message.result.type === "subscription_started") {
      if (process.env.DEBUG) console.log("[bridge] subscription_started", message.id);
      return;
    }
  }
  if (message.id && message.error) {
    console.error("[bridge] subscription rejected:", message.error.message || message.error.code);
    return;
  }

  const eventName = String(message.event || message.data?.type || "");
  if (process.env.DEBUG && eventName) console.log("[bridge] socket event", eventName, message.data?.pane_id ?? "");
  if (!eventName) return;

  if (eventName.includes("events_lost")) {
    console.error("[bridge] events_lost; resubscribing and reconciling");
    scheduleReconcile(0);
    return;
  }

  const data = message.data || {};

  if (eventName.includes("agent_status_changed")) {
    if (data.pane_id) setStatus(data.pane_id, normalizeStatus(data.agent_status), data);
    return;
  }

  if (eventName.includes("agent_detected")) {
    const paneId = data.pane_id;
    if (!paneId) return;
    if (data.released || data.final_status === "unknown") {
      agents.delete(paneId);
      closeSubscription(`pane:${paneId}`);
      return;
    }
    // Subscribe before the reconcile so a short-lived agent's status event is
    // not lost while session.snapshot is in flight.
    openSubscription(`pane:${paneId}`, [
      { type: "pane.agent_status_changed", pane_id: paneId },
    ]);
    scheduleReconcile(250);
    return;
  }

  if (eventName.includes("pane.created")) {
    if (data.pane_id) {
      openSubscription(`pane:${data.pane_id}`, [
        { type: "pane.agent_status_changed", pane_id: data.pane_id },
      ]);
    }
    scheduleReconcile(250);
    return;
  }

  if (eventName.includes("pane.closed") || eventName.includes("pane.exited")) {
    const paneId = data.pane_id;
    if (!paneId) return;
    agents.delete(paneId);
    closeSubscription(`pane:${paneId}`);
  }
}

function setStatus(paneId, status, data = {}) {
  let row = agents.get(paneId);
  const at = nowIso();
  if (!row) {
    row = {
      pane_id: paneId,
      name: data.name ?? null,
      agent: data.agent ?? null,
      agent_status: status,
      status_since: at,
      last_change_seq: Number(data.state_change_seq ?? 0),
    };
    agents.set(paneId, row);
    publish(row);
    return;
  }

  if (data.name !== undefined) row.name = data.name;
  if (data.agent !== undefined && data.agent !== null) row.agent = data.agent;
  if (data.state_change_seq !== undefined) row.last_change_seq = Number(data.state_change_seq);

  if (row.agent_status !== status) {
    row.agent_status = status;
    row.status_since = at;
    publish(row);
  }
}

function syncAgents(snapshotAgents) {
  const seen = new Set();
  const at = nowIso();

  for (const info of snapshotAgents || []) {
    const paneId = info?.pane_id;
    if (!paneId || !info.agent) continue;
    seen.add(paneId);
    const status = normalizeStatus(info.agent_status);
    const previous = agents.get(paneId);
    if (!previous) {
      const row = {
        pane_id: paneId,
        name: info.name ?? null,
        agent: info.agent,
        agent_status: status,
        status_since: at,
        last_change_seq: Number(info.state_change_seq ?? 0),
      };
      agents.set(paneId, row);
      publish(row);
      continue;
    }
    if (info.name !== undefined) previous.name = info.name;
    previous.agent = info.agent;
    previous.last_change_seq = Number(info.state_change_seq ?? previous.last_change_seq);
    if (previous.agent_status !== status) {
      previous.agent_status = status;
      previous.status_since = at;
      publish(previous);
    }
  }

  for (const paneId of [...agents.keys()]) {
    if (!seen.has(paneId)) agents.delete(paneId);
  }
}

async function reconcileAll() {
  if (stopping) return;
  if (reconciling) {
    reconcileAgain = true;
    return;
  }
  reconciling = true;
  try {
    closeAllSubscriptions();
    const result = await requestOnce("session.snapshot", {});
    const snapshot = result?.snapshot ?? {};
    const snapshotAgents = snapshot.agents ?? result?.agents ?? [];
    syncAgents(snapshotAgents);

    openSubscription("global", GLOBAL_SUBSCRIPTIONS);
    // Subscribe to every pane, not only panes already reporting an agent:
    // a pane can become an agent between snapshots, and its first status
    // event must not be missed while agent_detected is being reconciled.
    const paneIds = new Set((snapshot.panes ?? []).map((pane) => pane.pane_id).filter(Boolean));
    for (const info of snapshotAgents) if (info?.pane_id) paneIds.add(info.pane_id);
    for (const paneId of paneIds) {
      openSubscription(`pane:${paneId}`, [
        { type: "pane.agent_status_changed", pane_id: paneId },
      ]);
    }
    retryDelayMs = 500;
  } catch (error) {
    console.error("[bridge] reconcile failed:", error.message);
    scheduleReconcile(retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 30000);
  } finally {
    reconciling = false;
    if (reconcileAgain) {
      reconcileAgain = false;
      scheduleReconcile(250);
    }
  }
}

function scheduleReconcile(delayMs = 250) {
  if (FAKE || stopping || reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileAll();
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Fake mode: one agent runs the full status script without a Herdr socket.

function startFake() {
  const makeAgent = (paneId, name) => {
    const row = {
      pane_id: paneId,
      name,
      agent: "opencode",
      agent_status: /** @type {AgentStatus} */ ("idle"),
      status_since: nowIso(),
      last_change_seq: 0,
    };
    agents.set(paneId, row);
    return row;
  };

  const setFakeStatus = (row, status) => {
    row.agent_status = /** @type {AgentStatus} */ (status);
    row.status_since = nowIso();
    row.last_change_seq += 1;
    publish(row);
  };

  const at = (delayMs, row, status) => {
    setTimeout(() => setFakeStatus(row, status), delayMs);
  };

  const p1 = makeAgent("fake:p1", "Fake Agent");

  if (FAKE_SCENARIO === "flip") {
    // working and done only 2s apart: only the final stable status may move.
    at(1500, p1, "working");
    at(3500, p1, "done");
    at(12000, p1, "idle");
    return;
  }

  if (FAKE_SCENARIO === "blocked2") {
    const p2 = makeAgent("fake:p2", "Fake Agent B");
    // p1 takes S, p2 takes S-2, p1 leaves (releasing S), then p1 returns.
    at(1500, p1, "blocked");
    at(8000, p2, "blocked");
    at(16000, p1, "working");
    at(30000, p1, "blocked");
    return;
  }

  // Default: one agent runs the full status script.
  const script = ["working", "blocked", "working", "done", "idle"];
  let step = 0;
  const advance = () => {
    const status = script[step++];
    if (!status) return;
    setFakeStatus(p1, status);
    if (step < script.length) setTimeout(advance, 10000);
  };
  setTimeout(advance, 1500);
}

// ---------------------------------------------------------------------------
// HTTP: /snapshot and /events

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method !== "GET") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (url.pathname === "/snapshot") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify([...agents.values()]));
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "Cache-Control": "no-store",
    });
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, fake: FAKE, agents: agents.size }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] http://${HOST}:${PORT} ${FAKE ? "(FAKE)" : `socket ${socketPath()}`}`);
});

if (FAKE) startFake();
else reconcileAll();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  closeAllSubscriptions();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
