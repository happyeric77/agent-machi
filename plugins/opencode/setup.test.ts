/**
 * Reporter wiring tests: these go through `setup()` with a fake context, so
 * handoff, bootstrap retry, removal and location-scoped reads are exercised in
 * the shape the plugin actually runs in.
 *
 * Every assertion here is on an observable effect — a bridge write or the
 * number of live subscriptions — never on an internal field.
 */
import assert from "node:assert/strict";
import test from "node:test";

// The plugin only runs when the server process has the ingest token.
process.env.AGENT_MACHI_INGEST_TOKEN ??= "test-token";

interface Row {
  id: string;
  title: string;
  location: { directory: string };
  time: { created: number; busy?: number; idle?: number; archived?: number };
}

interface World {
  rows: Map<string, Row>;
  bus: Array<(event: any) => void>;
  emit(event: any): void;
  /** Every bridge request the plugin made, in order. */
  writes: Array<{ method: string; id: string; status?: string; name?: string }>;
  /** Live event subscriptions: a leak shows up as a count above one. */
  subscriptions: number;
}

function world(): World {
  const rows = new Map<string, Row>();
  const bus: Array<(event: any) => void> = [];
  const writes: World["writes"] = [];
  const state = {
    rows,
    bus,
    writes,
    subscriptions: 0,
    emit: (event: any) => bus.forEach((listener) => listener(event)),
  };
  return state;
}

interface Options {
  bridgeUrl?: string;
  machineId?: string;
  listFails?: number;
  directory?: string;
  /** Permission ids to report for a session. */
  permissions?: (sessionID: string, calls: number) => string[] | null;
  /** Resolve a `get` only when released, to hold a read open. */
  gate?: { release: () => void } | null;
}

function makeCtx(shared: World, opts: Options = {}) {
  const directory = opts.directory ?? "/tmp/project";
  let listFails = opts.listFails ?? 0;
  let permitCalls = 0;
  const calls = { list: 0, get: 0 };
  const ctx: any = {
    location: { directory },
    options: {
      bridgeUrl: opts.bridgeUrl ?? "http://127.0.0.1:9/town",
      machineId: opts.machineId ?? "mini",
    },
    session: {
      async list() {
        calls.list += 1;
        if (listFails > 0) {
          listFails -= 1;
          throw new Error("list is down");
        }
        return { data: [...shared.rows.values()] };
      },
      async get({ sessionID }: { sessionID: string }) {
        calls.get += 1;
        if (opts.gate) {
          await new Promise<void>((resolve) => {
            const gate = opts.gate as { release: () => void };
            gate.release = () => resolve();
          });
        }
        const row = shared.rows.get(sessionID);
        if (!row) throw Object.assign(new Error("not found"), { _tag: "Session.NotFoundError" });
        return row;
      },
    },
    permission: {
      async list({ sessionID }: { sessionID: string }) {
        permitCalls += 1;
        if (!opts.permissions) return [];
        const ids = opts.permissions(sessionID, permitCalls);
        // A null stands for an unreadable answer, which must not clear a prompt.
        return ids === null ? { unexpected: true } : ids.map((id) => ({ id }));
      },
    },
    event: {
      async *subscribe({ signal }: { signal?: AbortSignal }) {
        shared.subscriptions += 1;
        const queue: any[] = [];
        shared.bus.push((event) => queue.push(event));
        try {
          while (!signal?.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally {
          shared.subscriptions -= 1;
        }
      },
    },
  };
  return { ctx, calls, permits: () => permitCalls };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a condition holds, or fail with what was observed. */
async function until(label: string, check: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}

let fetchCount = 0;
/** A fetch that records bridge writes and always succeeds. */
function installFetch(shared: World): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    fetchCount += 1;
    const url = new URL(String(input));
    const method = String(init.method ?? "GET");
    const id = method === "DELETE" ? (url.searchParams.get("id") ?? "") : (JSON.parse(String(init.body)).id ?? "");
    const body = method === "DELETE" ? null : JSON.parse(String(init.body));
    shared.writes.push({ method, id, status: body?.status, name: body?.name });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

async function loadPlugin(): Promise<any> {
  const mod: any = await import("./index.ts");
  mod.stopAllReporters();
  return mod.default;
}

test("a second location keeps the first's resident renewing, and unloading it re-elects", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const a = makeCtx(shared, { directory: "/tmp/a" });
  const stopA = await plugin.setup(a.ctx);
  assert.equal(typeof stopA, "function");
  // An idle resident that only A can see.
  shared.rows.set("ses_idle", {
    id: "ses_idle",
    title: "idle-a",
    location: { directory: "/tmp/a" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_idle" } });
  await until("A reports its resident", () => shared.writes.some((w) => w.id === "mini-ses_idle"));
  const before = shared.writes.length;

  const b = makeCtx(shared, { directory: "/tmp/b", bridgeUrl: "http://127.0.0.1:9/town/" });
  const stopB = await plugin.setup(b.ctx);
  // One shared writer: a second location must not open a second subscription.
  await wait(50);
  assert.equal(shared.subscriptions, 1, "one live subscription, not one per setup");

  const idle = shared.rows.get("ses_idle");
  assert.ok(idle && idle.title === "idle-a", "the first location's row is still there");
  stopB?.();
  await wait(50);
  assert.equal(shared.subscriptions, 1, "a survivor took the stream over");
  assert.ok(shared.writes.length >= before, "reporting continued");
  stopA?.();
  await wait(50);
  assert.equal(shared.subscriptions, 0, "the last unload closed the stream");
});

test("a failed bootstrap is retried and the executing session still appears", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  // Only a successful list read can find this one.
  shared.rows.set("ses_boot", {
    id: "ses_boot",
    title: "boot",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });

  const one = makeCtx(shared, { listFails: 1 });
  const stop = await plugin.setup(one.ctx);
  await until(
    "the retried bootstrap discovers the session",
    () => shared.writes.some((w) => w.id === "mini-ses_boot" && w.status === "working"),
    8_000,
  );
  assert.ok(one.calls.list >= 2, `list was retried (${one.calls.list})`);
  stop?.();
});

test("a duplicate cleanup never evicts the replacement reporter", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const a = makeCtx(shared);
  const stopA = await plugin.setup(a.ctx);
  stopA?.();
  stopA?.(); // duplicate cleanup, before anything replaces it

  const b = makeCtx(shared);
  const stopB = await plugin.setup(b.ctx);
  // A third setup must join B, not create a second writer beside it.
  const c = makeCtx(shared);
  const stopC = await plugin.setup(c.ctx);
  await wait(50);
  assert.equal(shared.subscriptions, 1, "one reporter, one subscription");
  stopC?.();
  stopB?.();
});

test("a session in a location with no setup is never read from another one", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const local = makeCtx(shared, { directory: "/tmp/local" });
  const stop = await plugin.setup(local.ctx);
  shared.rows.set("ses_far", {
    id: "ses_far",
    title: "far",
    location: { directory: "/tmp/elsewhere" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_far" } });
  await until("the foreign session is reported", () =>
    shared.writes.some((w) => w.id === "mini-ses_far"),
  );
  // It is reported, but its prompts are never read: the only setup here lives
  // in another directory.
  assert.equal(local.permits(), 0, "no prompt read came from the wrong location");
  stop?.();
});

test("an archived session stays gone, and a fresh read is what brings one back", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const ctxh = makeCtx(shared);
  const stop = await plugin.setup(ctxh.ctx);
  shared.rows.set("ses_gone", {
    id: "ses_gone",
    title: "gone",
    location: { directory: "/tmp/project" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_gone" } });
  await until("it is reported", () => shared.writes.some((w) => w.id === "mini-ses_gone"));

  shared.rows.get("ses_gone")!.time.archived = Date.now();
  shared.emit({ type: "session.archived", data: { sessionID: "ses_gone" } });
  await until("the delete lands", () => shared.writes.some((w) => w.method === "DELETE"));
  const afterDelete = shared.writes.length;

  // A bare event (a rename) must not bring it back: the row is still archived.
  shared.emit({ type: "session.renamed", data: { sessionID: "ses_gone", title: "revived?" } });
  await wait(120);
  assert.equal(
    shared.writes.slice(afterDelete).filter((w) => w.method === "POST").length,
    0,
    "no POST resurrected an archived resident",
  );
  stop?.();
});

test("a prompt read that cannot answer never clears a pending prompt", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  // The first read is unreadable, later ones are a real empty list.
  const ctx = makeCtx(shared, {
    permissions: (_sessionID, calls) => (calls === 1 ? null : []),
  });
  const stop = await plugin.setup(ctx.ctx);
  shared.rows.set("ses_p", {
    id: "ses_p",
    title: "p",
    location: { directory: "/tmp/project" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_p" } });
  await until("it is reported", () => shared.writes.some((w) => w.id === "mini-ses_p"));
  shared.emit({ type: "permission.asked", data: { sessionID: "ses_p", id: "per_1" } });
  await until("the prompt blocks it", () =>
    shared.writes.some((w) => w.id === "mini-ses_p" && w.status === "blocked"),
  );
  const blockedCount = shared.writes.filter(
    (w) => w.id === "mini-ses_p" && w.status === "idle",
  ).length;
  // A reconcile pass with an unreadable prompt list must not unblock it.
  shared.emit({ type: "tick" });
  await wait(200);
  assert.equal(
    shared.writes.filter((w) => w.id === "mini-ses_p" && w.status === "idle").length,
    blockedCount,
    "an unreadable list did not clear the prompt",
  );
  stop?.();
});

test("a child session never becomes a resident, even via its own event", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const ctx = makeCtx(shared);
  const stop = await plugin.setup(ctx.ctx);
  shared.rows.set("ses_child", {
    id: "ses_child",
    title: "subagent",
    parentID: "ses_parent",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  } as any);
  // The event path goes through reconcile, not the list, so this is the case
  // that used to slip past the parent check.
  shared.emit({ type: "session.created", data: { sessionID: "ses_child" } });
  await wait(400);
  assert.equal(
    shared.writes.filter((w) => w.id.includes("ses_child")).length,
    0,
    "a child session was never reported",
  );
  stop?.();
});

test("an archived resident returns only when a fresh read proves it live", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const ctx = makeCtx(shared);
  const stop = await plugin.setup(ctx.ctx);
  shared.rows.set("ses_r", {
    id: "ses_r",
    title: "r",
    location: { directory: "/tmp/project" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_r" } });
  await until("reported", () => shared.writes.some((w) => w.id === "mini-ses_r"));

  shared.rows.get("ses_r")!.time.archived = Date.now();
  shared.emit({ type: "session.archived", data: { sessionID: "ses_r" } });
  await until("deleted", () => shared.writes.some((w) => w.method === "DELETE"));
  const afterDelete = shared.writes.length;

  // Unarchived and running again: the next lifecycle event reads the row, and
  // that fresh read is what admits it. No tombstone is consulted.
  delete shared.rows.get("ses_r")!.time.archived;
  shared.rows.get("ses_r")!.time.busy = Date.now();
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_r" } });
  await until(
    "a fresh read revives it",
    () => shared.writes.slice(afterDelete).some((w) => w.method === "POST" && w.status === "working"),
    8_000,
  );
  stop?.();
});

test("a failed seed on reconnect is retried after a successful startup", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  // Startup succeeds with one resident.
  const ctx = makeCtx(shared);
  // Bootstrap only seeds sessions that are executing: an idle one is not
  // re-added by a reload, by design.
  shared.rows.set("ses_seen", {
    id: "ses_seen",
    title: "seen",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  const stop = await plugin.setup(ctx.ctx);
  await until("startup seed reported", () => shared.writes.some((w) => w.id === "mini-ses_seen"));

  // A session that starts while the list is failing must still be found once
  // the list recovers: retry is owed for the failed read, not for "first ever".
  shared.rows.set("ses_late", {
    id: "ses_late",
    title: "late",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  // A separate reporter (its own machine id): the point is that ITS failed seed
  // is retried even though another reporter started successfully long before.
  const failing = makeCtx(shared, { listFails: 1, machineId: "mini2" });
  // A second location re-seeds; its first list read fails.
  const stop2 = await plugin.setup(failing.ctx);
  await until(
    "the retried seed finds the late session",
    () => shared.writes.some((w) => w.id === "mini2-ses_late"),
    12_000,
  );
  stop2?.();
  stop?.();
});

export { fetchCount };
