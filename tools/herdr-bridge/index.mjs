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
const HOST = process.env.HOST || "0.0.0.0";
const EVENT_LOG = path.join(HERE, "events.jsonl");

const STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

/** @typedef {"idle"|"working"|"blocked"|"done"|"unknown"} AgentStatus */
/** @typedef {{pane_id:string,name:string|null,display_name:string,terminal_title_stripped:string|null,agent:string|null,agent_status:AgentStatus,status_since:string,last_change_seq:number}} AgentRow */

/** @type {Map<string, AgentRow>} */
const agents = new Map();
/** @type {Map<string, {cwd: string|null, foreground_cwd: string|null}>} */
const locations = new Map();
/** @type {Map<string, number>} */
const firstSeen = new Map();
let seenSeq = 0;
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

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function markSeen(paneId) {
  if (!firstSeen.has(paneId)) firstSeen.set(paneId, ++seenSeq);
}

function cwdBase(raw) {
  const value = clean(raw).replace(/\/+$/, "");
  if (!value || value === "/") return null;
  if (value === HOME) return null;
  if (["/tmp", "/private/tmp", "/var/tmp", "/Users", "/private", "/home"].includes(value)) return null;
  const base = value.split("/").pop();
  if (!base || base === "tmp") return null;
  return base;
}

function baseDisplayName(row) {
  const named = clean(row.name);
  if (named) return named;
  const place = locations.get(row.pane_id);
  for (const cwd of [place?.foreground_cwd, place?.cwd]) {
    const base = cwdBase(cwd);
    if (base) return base;
  }
  return clean(row.agent) || row.pane_id;
}

// First-seen pane keeps the plain name; later collisions get " (2)", " (3)".
function refreshDisplayNames() {
  const used = new Map();
  const ordered = [...agents.values()].sort(
    (a, b) => (firstSeen.get(a.pane_id) ?? 0) - (firstSeen.get(b.pane_id) ?? 0),
  );
  for (const row of ordered) {
    const base = baseDisplayName(row);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    row.display_name = count === 1 ? base : `${base} (${count})`;
  }
}

function removeAgentRow(paneId) {
  agents.delete(paneId);
  locations.delete(paneId);
  firstSeen.delete(paneId);
  refreshDisplayNames();
}

/** @param {AgentRow} row */
function publish(row) {
  const event = {
    source: "herdr",
    pane_id: row.pane_id,
    name: row.name,
    display_name: row.display_name,
    terminal_title_stripped: row.terminal_title_stripped,
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

  // Herdr mixes dotted and underscored event names (pane.agent_status_changed
  // but pane_created/pane_closed), so normalize before matching.
  const eventName = String(message.event || message.data?.type || "").replaceAll(".", "_");
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
      removeAgentRow(paneId);
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

  if (eventName.includes("pane_created")) {
    if (data.pane_id) {
      openSubscription(`pane:${data.pane_id}`, [
        { type: "pane.agent_status_changed", pane_id: data.pane_id },
      ]);
    }
    scheduleReconcile(250);
    return;
  }

  if (eventName.includes("pane_closed") || eventName.includes("pane_exited")) {
    const paneId = data.pane_id;
    if (!paneId) return;
    removeAgentRow(paneId);
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
      display_name: "",
      terminal_title_stripped: data.terminal_title_stripped ?? data.title ?? null,
      agent: data.agent ?? null,
      agent_status: status,
      status_since: at,
      last_change_seq: Number(data.state_change_seq ?? 0),
    };
    locations.set(paneId, {
      cwd: data.cwd ?? null,
      foreground_cwd: data.foreground_cwd ?? null,
    });
    markSeen(paneId);
    agents.set(paneId, row);
    refreshDisplayNames();
    publish(row);
    return;
  }

  if (data.name !== undefined) row.name = data.name;
  if (data.terminal_title_stripped !== undefined) row.terminal_title_stripped = data.terminal_title_stripped;
  else if (data.title !== undefined) row.terminal_title_stripped = data.title;
  if (data.agent !== undefined && data.agent !== null) row.agent = data.agent;
  if (data.state_change_seq !== undefined) row.last_change_seq = Number(data.state_change_seq);
  const place = locations.get(paneId) ?? { cwd: null, foreground_cwd: null };
  if (data.cwd !== undefined) place.cwd = data.cwd;
  if (data.foreground_cwd !== undefined) place.foreground_cwd = data.foreground_cwd;
  locations.set(paneId, place);
  refreshDisplayNames();

  if (row.agent_status !== status) {
    row.agent_status = status;
    row.status_since = at;
    publish(row);
  }
}

function syncAgents(snapshotAgents) {
  const seen = new Set();
  const at = nowIso();
  const changed = [];

  for (const info of snapshotAgents || []) {
    const paneId = info?.pane_id;
    if (!paneId || !info.agent) continue;
    seen.add(paneId);
    const status = normalizeStatus(info.agent_status);
    locations.set(paneId, {
      cwd: info.cwd ?? null,
      foreground_cwd: info.foreground_cwd ?? null,
    });
    const previous = agents.get(paneId);
    if (!previous) {
      const row = {
        pane_id: paneId,
        name: info.name ?? null,
        display_name: "",
        terminal_title_stripped: info.terminal_title_stripped ?? info.terminal_title ?? null,
        agent: info.agent,
        agent_status: status,
        status_since: at,
        last_change_seq: Number(info.state_change_seq ?? 0),
      };
      markSeen(paneId);
      agents.set(paneId, row);
      changed.push(row);
      continue;
    }
    if (info.name !== undefined) previous.name = info.name;
    if (info.terminal_title_stripped !== undefined) {
      previous.terminal_title_stripped = info.terminal_title_stripped;
    } else if (info.terminal_title !== undefined) {
      previous.terminal_title_stripped = info.terminal_title;
    }
    previous.agent = info.agent;
    previous.last_change_seq = Number(info.state_change_seq ?? previous.last_change_seq);
    if (previous.agent_status !== status) {
      previous.agent_status = status;
      previous.status_since = at;
      changed.push(previous);
    }
  }

  for (const paneId of [...agents.keys()]) {
    if (!seen.has(paneId)) removeAgentRow(paneId);
  }
  refreshDisplayNames();
  for (const row of changed) publish(row);
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
  const makeAgent = (paneId, name, cwd = "/Users/macbookpro4eric/Projects/agent-machi") => {
    const row = {
      pane_id: paneId,
      name,
      display_name: "",
      terminal_title_stripped: null,
      agent: "opencode",
      agent_status: /** @type {AgentStatus} */ ("idle"),
      status_since: nowIso(),
      last_change_seq: 0,
    };
    locations.set(paneId, { cwd, foreground_cwd: cwd });
    markSeen(paneId);
    agents.set(paneId, row);
    refreshDisplayNames();
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

  if (FAKE_SCENARIO === "demo") {
    // Recording prop: three named agents (Amber, Teal, Moss) follow the
    // timeline in the delivery notes. Not ported to the Go binary.
    const amber = makeAgent("fake:p1", null);
    const teal = makeAgent("fake:p2", null, "/tmp/runwarden");
    const moss = makeAgent("fake:p3", null, "/tmp");
    at(1500, amber, "working"); // Amber -> P4 office
    at(12000, teal, "working"); // Teal -> P2 office
    at(21000, amber, "blocked"); // Amber -> station S
    at(33000, amber, "working"); // Amber -> P4 office
    at(39000, teal, "done"); // Teal stays in P2, done badge
    at(47000, teal, "idle"); // Teal -> east beach
    at(54000, moss, "working"); // Moss -> P1 office
    return;
  }

  if (FAKE_SCENARIO === "signnames") {
    // Two working residents: one has no name (sign falls back to pane_id),
    // one has a long name (font must shrink without overflowing the panel).
    const paneId = makeAgent("w7:p2", null);
    const longName = makeAgent("fake:p-long", "Wakamiya Coffee Roaster");
    at(1500, paneId, "working");
    at(1500, longName, "working");
    return;
  }

  if (FAKE_SCENARIO === "dupe") {
    // Two unnamed agents in the same project: display_name must dedupe by
    // first-seen order, not both read "agent-machi".
    const a = makeAgent("fake:p1", null);
    const b = makeAgent("fake:p2", null);
    at(1500, a, "working");
    at(2500, b, "working");
    return;
  }

  if (FAKE_SCENARIO === "panelnames") {
    // Six role agents plus one log-only agent.
    const a = makeAgent("fake:p1", null);
    const b = makeAgent("fake:p2", null);
    const c = makeAgent("fake:p3", null, "/tmp");
    const d = makeAgent("fake:p4", null, "/tmp/agent-a");
    const e = makeAgent("fake:p5", null, "/tmp/agent-b");
    const f = makeAgent("fake:p6", null, "/tmp/agent-c");
    const g = makeAgent("fake:p7", null, "/tmp/runwarden");
    at(1500, a, "working");
    at(2500, b, "working");
    at(3500, c, "working");
    at(4500, d, "working");
    at(5500, e, "working");
    at(6500, f, "working");
    at(7500, g, "working");
    return;
  }

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

  if (FAKE_SCENARIO === "roster") {
    const p2 = makeAgent("fake:p2", "Fake Agent B");
    const p3 = makeAgent("fake:p3", "Fake Agent C");
    // Three agents, interleaved. p1/p2 get characters; p3 is log only.
    at(1500, p1, "working");
    at(4500, p2, "working");
    at(7500, p3, "working");
    at(14000, p1, "blocked");
    at(17000, p3, "done");
    at(20000, p2, "blocked");
    at(26000, p1, "working");
    at(32000, p2, "done");
    at(35000, p3, "idle");
    return;
  }

  if (FAKE_SCENARIO === "cast") {
    const p2 = makeAgent("fake:p2", "Fake Agent B");
    const p3 = makeAgent("fake:p3", "Fake Agent C");
    const p4 = makeAgent("fake:p4", "Fake Agent D");
    // Four agents: Amber, Teal, Moss, Plum. All reach a home, then diverge.
    at(1500, p1, "working");
    at(2500, p2, "working");
    at(3500, p3, "working");
    at(4500, p4, "working");
    at(18000, p2, "blocked");
    at(22000, p3, "idle");
    at(26000, p4, "done");
    at(30000, p2, "working");
    return;
  }

  if (FAKE_SCENARIO === "home4") {
    // Four agents, all settle into their homes; for doorstep/sign spot checks.
    const p2 = makeAgent("fake:p2", "Fake Agent B");
    const p3 = makeAgent("fake:p3", "Fake Agent C");
    const p4 = makeAgent("fake:p4", "Fake Agent D");
    at(1500, p1, "working");
    at(2500, p2, "working");
    at(3500, p3, "working");
    at(4500, p4, "working");
    return;
  }

  if (FAKE_SCENARIO === "beach3") {
    const p2 = makeAgent("fake:p2", "Fake Agent B");
    const p3 = makeAgent("fake:p3", "Fake Agent C");
    at(1500, p1, "working");
    at(2500, p2, "working");
    at(3500, p3, "working");
    at(12000, p1, "idle");
    at(12000, p2, "idle");
    at(13000, p3, "idle");
    // p1 leaves the beach; p4 arrives later and must inherit its spot.
    at(30000, p1, "working");
    setTimeout(() => {
      const p4 = makeAgent("fake:p4", "Fake Agent D");
      setFakeStatus(p4, "working");
      setTimeout(() => setFakeStatus(p4, "idle"), 4000);
    }, 32000);
    return;
  }

  if (FAKE_SCENARIO === "castreuse") {
    const p2 = makeAgent("fake:p2", "Fake Agent B");
    const p3 = makeAgent("fake:p3", "Fake Agent C");
    const p4 = makeAgent("fake:p4", "Fake Agent D");
    // p3 holds Moss. Remove it, then a new agent should inherit slot 2.
    at(1500, p1, "working");
    at(2500, p2, "working");
    at(3500, p3, "working");
    at(4500, p4, "working");
    setTimeout(() => {
      agents.delete("fake:p3");
    }, 10000);
    setTimeout(() => {
      at(0, makeAgent("fake:p5", "Fake Agent E"), "working");
    }, 35000);
    return;
  }


  if (FAKE_SCENARIO === "home") {
    // One agent: home -> blocked -> home(done) -> beach(idle), then repeat.
    // The loop lets a manually opened page join at any phase.
    const cycle = () => {
      at(0, p1, "working");
      at(16000, p1, "blocked");
      at(32000, p1, "done");
      at(48000, p1, "idle");
      setTimeout(cycle, 64000);
    };
    setTimeout(cycle, 8000);
    return;
  }

  if (FAKE_SCENARIO === "homeblock") {
    // Enter the home, then flip to blocked: the traveller must come back out
    // visibly and finish at the station, never stuck invisible.
    at(10000, p1, "working");
    at(15000, p1, "blocked");
    return;
  }

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

  if (url.pathname === "/log") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(rawLimit) ? Math.min(2000, Math.max(1, Math.floor(rawLimit))) : 200;
    let events = [];
    try {
      const text = fs.readFileSync(EVENT_LOG, "utf8");
      events = text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line);
            return parsed && typeof parsed === "object" ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (error.code !== "ENOENT") console.error("[bridge] cannot read events.jsonl:", error.message);
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(events.slice(-limit)));
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
