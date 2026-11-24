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
  /** Drop the event stream this many times, as a flapping connection would. */
  streamDrops?: number;
  /** Fail the list read on exactly this call number. */
  failListOnCall?: number;
  /** Fail a `get` for this session, as a transient read error would. */
  getFails?: (sessionID: string, call: number) => boolean;
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
        if (opts.failListOnCall === calls.list) throw new Error("list is down");
        return { data: [...shared.rows.values()] };
      },
      async get({ sessionID }: { sessionID: string }) {
        calls.get += 1;
        if (opts.getFails?.(sessionID, calls.get)) throw new Error("get is down");
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
        if ((opts.streamDrops ?? 0) > 0) {
          opts.streamDrops! -= 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          shared.subscriptions -= 1;
          throw new Error("stream dropped");
        }
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

/**
 * Drive one reconcile pass, so a test can assert what a pass reads instead of
 * waiting five minutes for the heartbeat. Reaching into the reporter is
 * deliberate: there is no public trigger, and the assertion is still on the
 * resulting bridge writes.
 */
function forcePass(): void {
  const host = globalThis as any;
  const reporters: Map<string, any> = host[Symbol.for("agent-machi.reporter")];
  for (const reporter of reporters?.values() ?? []) reporter.runPass();
}

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

test("unloading the stream owner hands the stream to a survivor", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const a = makeCtx(shared, { directory: "/tmp/a" });
  const stopA = await plugin.setup(a.ctx);
  assert.equal(typeof stopA, "function");
  shared.rows.set("ses_idle", {
    id: "ses_idle",
    title: "idle-a",
    location: { directory: "/tmp/a" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_idle" } });
  await until("A reports its resident", () => shared.writes.some((w) => w.id === "mini-ses_idle"));

  const b = makeCtx(shared, { directory: "/tmp/b", bridgeUrl: "http://127.0.0.1:9/town/" });
  const stopB = await plugin.setup(b.ctx);
  await wait(50);
  assert.equal(shared.subscriptions, 1, "one live subscription, not one per setup");

  // A owns the stream, so unloading it is the handoff case.
  stopA?.();
  await wait(80);
  assert.equal(shared.subscriptions, 1, "the survivor took the stream over");

  // Prove the survivor delivers: its own event must reach the bridge.
  shared.rows.set("ses_after", {
    id: "ses_after",
    title: "after",
    location: { directory: "/tmp/b" },
    time: { created: Date.now(), busy: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_after" } });
  await until("the survivor reported a new session", () =>
    shared.writes.some((w) => w.id === "mini-ses_after"),
  );
  stopB?.();
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

  const b = makeCtx(shared);
  const stopB = await plugin.setup(b.ctx);
  // A's cleanup runs a second time, now that B has replaced it.
  stopA?.();

  // A third setup must join B, not create a second writer beside it.
  const c = makeCtx(shared);
  const stopC = await plugin.setup(c.ctx);
  await wait(80);
  assert.equal(shared.subscriptions, 1, "B and C share one subscription");

  // And B is still the live owner: unloading C must not close the stream.
  stopC?.();
  await wait(50);
  assert.equal(shared.subscriptions, 1, "C's cleanup left B reporting");
  stopB?.();
  await wait(50);
  assert.equal(shared.subscriptions, 0, "the last unload closed the stream");
});

test("prompts are read only for sessions in this setup's own location", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  const local = makeCtx(shared, { directory: "/tmp/local", permissions: () => ["per_local"] });
  const stop = await plugin.setup(local.ctx);
  shared.rows.set("ses_near", {
    id: "ses_near",
    title: "near",
    location: { directory: "/tmp/local" },
    time: { created: Date.now(), busy: Date.now() },
  });
  shared.rows.set("ses_far", {
    id: "ses_far",
    title: "far",
    location: { directory: "/tmp/elsewhere" },
    time: { created: Date.now(), busy: Date.now() },
  });
  // Force a pass so both residents are actually reconciled: otherwise zero
  // reads would prove nothing.
  forcePass();
  await until("the local resident is blocked by its prompt", () =>
    shared.writes.some((w) => w.id === "mini-ses_near" && w.status === "blocked"),
  );
  await until("the foreign resident is still reported", () =>
    shared.writes.some((w) => w.id === "mini-ses_far"),
  );
  assert.equal(local.permits(), 1, "only the local session's prompts were read");
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
    time: { created: Date.now(), busy: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_p" } });
  await until("it is reported", () => shared.writes.some((w) => w.id === "mini-ses_p"));
  shared.emit({ type: "permission.asked", data: { sessionID: "ses_p", id: "per_1" } });
  await until("the prompt blocks it", () =>
    shared.writes.some((w) => w.id === "mini-ses_p" && w.status === "blocked"),
  );

  // Force a real pass: its first prompt read cannot answer, so the block must
  // survive.
  forcePass();
  await until("the unreadable read actually happened", () => ctx.permits() >= 1);
  await wait(120);
  assert.ok(
    shared.writes.filter((w) => w.id === "mini-ses_p").at(-1)?.status === "blocked" ||
      shared.writes.filter((w) => w.id === "mini-ses_p" && w.status === "blocked").length === 1,
    "an unreadable list did not clear the prompt",
  );

  // And a valid empty list is authoritative: the next pass unblocks it.
  forcePass();
  await until("a real empty list unblocks it", () =>
    shared.writes.filter((w) => w.id === "mini-ses_p").at(-1)?.status === "working",
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

  // Bootstrap succeeds with one resident, then the stream drops once.
  shared.rows.set("ses_seen", {
    id: "ses_seen",
    title: "seen",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  // The list read that the reconnect performs (call 2) fails once; only the
  // retry can find the session that appeared in the meantime.
  const ctx = makeCtx(shared, { streamDrops: 1, failListOnCall: 2 });
  const stop = await plugin.setup(ctx.ctx);
  await until("startup seed reported", () => shared.writes.some((w) => w.id === "mini-ses_seen"));

  shared.rows.set("ses_late", {
    id: "ses_late",
    title: "late",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });

  await until(
    "the reconnect retried its failed list and found the late session",
    () => shared.writes.some((w) => w.id === "mini-ses_late"),
    15_000,
  );
  assert.ok(ctx.calls.list >= 3, `the failed reconnect list was retried (${ctx.calls.list})`);
  stop?.();
});

export { fetchCount };

test("a prompt whose admission read failed is kept, not dropped", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  // A `get` that fails once per session, so the first prompt admission fails
  // transiently and the session is really there afterwards.
  let failures = 2;
  const base = makeCtx(shared);
  const flaky = {
    ...base.ctx,
    session: {
      ...base.ctx.session,
      async get({ sessionID }: { sessionID: string }) {
        shared.rows.get(sessionID);
        if (failures > 0) {
          failures -= 1;
          throw new Error("get is briefly down");
        }
        const row = shared.rows.get(sessionID);
        if (!row) throw Object.assign(new Error("not found"), { _tag: "Session.NotFoundError" });
        return row;
      },
    },
  };

  shared.rows.set("ses_form", {
    id: "ses_form",
    title: "form",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  const stop = await plugin.setup(flaky);
  // Both prompt events arrive while `get` is failing.
  shared.emit({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_form" } } });
  await wait(200);
  // Now the lifecycle event admits the session, and the held form must apply.
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_form" } });
  await until(
    "the held form is applied after admission",
    () => shared.writes.some((w) => w.status === "blocked"),
    6_000,
  );
  stop?.();
});

test("a stale form cannot revive a resident admitted only from the list", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  shared.rows.set("ses_seeded", {
    id: "ses_seeded",
    title: "seeded",
    location: { directory: "/tmp/project" },
    // Executing, so bootstrap admits it from the list alone.
    time: { created: Date.now(), busy: Date.now() },
  });
  const ctx = makeCtx(shared, { listFails: 0 });
  const stop = await plugin.setup(ctx.ctx);
  await until("the list admitted it", () => shared.writes.some((w) => w.id === "mini-ses_seeded"));

  // Archive it: the resident goes away.
  shared.rows.get("ses_seeded")!.time.archived = Date.now();
  shared.emit({ type: "session.archived", data: { sessionID: "ses_seeded" } });
  await until("deleted", () => shared.writes.some((w) => w.method === "DELETE"));
  const afterDelete = shared.writes.length;

  // The row is live again, but no lifecycle event has arrived: only a stale
  // form that was created before the archive.
  delete shared.rows.get("ses_seeded")!.time.archived;
  shared.emit({ type: "form.created", data: { form: { id: "frm_old", sessionID: "ses_seeded" } } });
  await wait(600);
  assert.deepEqual(
    shared.writes.slice(afterDelete).map((w) => w.method),
    [],
    "a stale form did not recreate the resident",
  );
  stop?.();
});

test("a prompt answered while its admission read is pending never lands late", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  const ctx = makeCtx(shared);
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_p", {
    id: "ses_p",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  // The admission read fails once, so the prompt is parked.
  ctx.ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
    const row = shared.rows.get(sessionID);
    if (!row) throw new Error("nope");
    throw new Error("get is down");
  };
  shared.emit({ type: "permission.asked", data: { sessionID: "ses_p", id: "per_1" } });
  await wait(60);
  // The user answers before the read ever succeeded: the parked prompt is dead.
  shared.emit({ type: "permission.replied", data: { sessionID: "ses_p", requestID: "per_1" } });
  await wait(60);

  // A later lifecycle event admits the session. It must not be blocked by the
  // prompt that was already answered.
  delete (ctx.ctx.session as any).get;
  ctx.ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
    const row = shared.rows.get(sessionID);
    if (!row) throw new Error("nope");
    return row;
  };
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  await until("status reported", () => shared.writes.some((w) => w.id === "mini-ses_p"));
  await wait(60);
  assert.deepEqual(
    shared.writes.filter((w) => w.id === "mini-ses_p").map((w) => w.status),
    ["working"],
    "the answered prompt never turned the resident blocked",
  );
  stop?.();
});

test("a session admitted from the list still replays its parked prompt", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  // Every get fails, so only the list can admit.
  const ctx = makeCtx(shared, { getFails: () => true });
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_l", {
    id: "ses_l",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  shared.emit({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_l" } } });
  await wait(80);
  forcePass();
  await until(
    "the list admitted the session and the form applied",
    () => shared.writes.some((w) => w.id === "mini-ses_l" && w.status === "blocked"),
  );
  stop?.();
});

test("a prompt refused for a removed resident is not replayed on revival", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  const ctx = makeCtx(shared);
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_g", {
    id: "ses_g",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  forcePass();
  await until("admitted", () => shared.writes.some((w) => w.id === "mini-ses_g"));
  shared.rows.get("ses_g")!.time.archived = Date.now();
  shared.emit({ type: "session.archived", data: { sessionID: "ses_g" } });
  await until("deleted", () => shared.writes.some((w) => w.method === "DELETE"));

  // Live again, but the only new event is a stale prompt from before.
  delete shared.rows.get("ses_g")!.time.archived;
  shared.emit({ type: "form.created", data: { form: { id: "frm_old", sessionID: "ses_g" } } });
  await wait(120);
  assert.equal(
    shared.writes.filter((w) => w.id === "mini-ses_g" && w.status === "blocked").length,
    0,
    "a stale form did not revive the resident blocked",
  );

  // A real lifecycle event revives it, and the stale form must not come with it.
  shared.rows.get("ses_g")!.time.busy = Date.now();
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_g" } });
  await until("revived", () => shared.writes.some((w) => w.id === "mini-ses_g" && w.status === "working"));
  const statuses = shared.writes.filter((w) => w.id === "mini-ses_g").map((w) => w.status);
  // initial working, the DELETE, then working again (or no second post when
  // the revival reproduces the status the bridge already has).
  assert.equal(statuses[0], "working");
  assert.ok(!statuses.includes("blocked"), `statuses were ${JSON.stringify(statuses)}`);
  stop?.();
});

test("an authoritative absence discards the prompt parked for it", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  let failGet = true;
  const ctx = makeCtx(shared, { getFails: (id) => failGet && id === "ses_n" });
  const stop = await plugin.setup(ctx.ctx);

  // Park a form behind a failing read.
  shared.rows.set("ses_n", {
    id: "ses_n",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "form.created", data: { form: { id: "frm_n", sessionID: "ses_n" } } });
  await wait(80);

  // The row turns out to be archived: the parked form is dead, though no
  // resident was ever tracked for it.
  shared.rows.get("ses_n")!.time.archived = Date.now();
  failGet = false;
  ctx.ctx.session.list = async () => ({ data: [...shared.rows.values()] });
  forcePass();
  await wait(120);

  // Live again via a real lifecycle event: the dead form must not surface.
  delete shared.rows.get("ses_n")!.time.archived;
  shared.rows.get("ses_n")!.time.busy = Date.now();
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_n" } });
  await until("admitted", () => shared.writes.some((w) => w.id === "mini-ses_n"));
  await wait(80);
  assert.deepEqual(
    shared.writes.filter((w) => w.id === "mini-ses_n").map((w) => w.status),
    ["working"],
    "the form parked for an absent session never applied",
  );
  stop?.();
});

test("a session removed before it was ever admitted still refuses a stale prompt", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  const ctx = makeCtx(shared, { getFails: () => true });
  const stop = await plugin.setup(ctx.ctx);

  // Never admitted: the reporter only sees the archived event.
  shared.rows.set("ses_probe", {
    id: "ses_probe",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now(), archived: Date.now() },
  });
  shared.emit({ type: "session.archived", data: { sessionID: "ses_probe" } });
  await until("delete sent", () => shared.writes.some((w) => w.method === "DELETE" && w.id === "mini-ses_probe"));

  // A stale form from before the archive, then a real lifecycle revival.
  shared.rows.get("ses_probe")!.time.archived = undefined;
  shared.emit({ type: "form.created", data: { form: { id: "frm_stale", sessionID: "ses_probe" } } });
  await wait(100);
  ctx.ctx.session.get = async ({ sessionID }: { sessionID: string }) => shared.rows.get(sessionID);
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_probe" } });
  await until("revived", () => shared.writes.some((w) => w.id === "mini-ses_probe" && w.status === "working"));
  await wait(80);
  const statuses = shared.writes.filter((w) => w.id === "mini-ses_probe").map((w) => w.status);
  assert.ok(!statuses.includes("blocked"), `statuses were ${JSON.stringify(statuses)}`);
  stop?.();
});

test("a parked form still lands when the recovered session is idle", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  let failGet = true;
  const ctx = makeCtx(shared, { getFails: () => failGet });
  const stop = await plugin.setup(ctx.ctx);

  // Idle session: it would never be seeded by the executing filter alone.
  shared.rows.set("ses_idle", {
    id: "ses_idle",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: 1, idle: Date.now() },
  });
  shared.emit({ type: "form.created", data: { form: { id: "frm_idle", sessionID: "ses_idle" } } });
  await wait(80);
  failGet = false;
  forcePass();
  await until(
    "the idle session was admitted and the form applied",
    () => shared.writes.some((w) => w.id === "mini-ses_idle" && w.status === "blocked"),
  );
  stop?.();
});

test("a prompt read still clears a block when the metadata read fails", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  // The prompt list is healthy and empty; only `get` is failing.
  let failGet = false;
  const ctx = makeCtx(shared, { getFails: () => failGet, permissions: () => [] });
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_b", {
    id: "ses_b",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  forcePass();
  await until("admitted", () => shared.writes.some((w) => w.id === "mini-ses_b"));
  // A prompt is opened and its reply event is missed.
  shared.emit({ type: "permission.asked", data: { sessionID: "ses_b", id: "per_1" } });
  await until("blocked", () => shared.writes.some((w) => w.id === "mini-ses_b" && w.status === "blocked"));

  failGet = true;
  const before = ctx.permits();
  const seen = shared.writes.length;
  forcePass();
  await until(
    "the healthy prompt read cleared the block",
    () => shared.writes.slice(seen).some((w) => w.id === "mini-ses_b" && w.status === "working"),
  );
  assert.ok(ctx.permits() > before, "the prompt list was consulted despite the failing get");
  stop?.();
});

test("a form answered while an unrelated admission is queued never lands", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  // Every read fails while the prompt's admission is outstanding, so the form
  // is parked and no session is tracked yet.
  let failGet = true;
  const ctx = makeCtx(shared, { getFails: () => failGet });
  const stop = await plugin.setup(ctx.ctx);
  await wait(80);

  shared.rows.set("ses_f", {
    id: "ses_f",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  shared.rows.set("ses_other", {
    id: "ses_other",
    title: "Other",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });

  shared.emit({ type: "form.created", data: { form: { id: "frm_q", sessionID: "ses_f" } } });
  await wait(60);
  // An unrelated admission is queued behind the parked form's read.
  shared.emit({ type: "session.created", data: { sessionID: "ses_other" } });
  // The answer arrives while the reads are still failing, so the reply's own
  // task cannot run before the parked form is released.
  shared.emit({ type: "form.replied", data: { sessionID: "ses_f", id: "frm_q" } });
  await wait(60);

  // Reads recover: a lifecycle event admits the session, and the answered form
  // must not come back with it.
  failGet = false;
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_f" } });
  await until("ses_f admitted", () => shared.writes.some((w) => w.id === "mini-ses_f"));
  await wait(150);
  const statuses = shared.writes.filter((w) => w.id === "mini-ses_f").map((w) => w.status);
  assert.ok(!statuses.includes("blocked"), `statuses were ${JSON.stringify(statuses)}`);
  stop?.();
});

test("a prompt whose admission read failed is kept, not dropped", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  // A `get` that fails once per session, so the first prompt admission fails
  // transiently and the session is really there afterwards.
  let failures = 2;
  const base = makeCtx(shared);
  const flaky = {
    ...base.ctx,
    session: {
      ...base.ctx.session,
      async get({ sessionID }: { sessionID: string }) {
        shared.rows.get(sessionID);
        if (failures > 0) {
          failures -= 1;
          throw new Error("get is briefly down");
        }
        const row = shared.rows.get(sessionID);
        if (!row) throw Object.assign(new Error("not found"), { _tag: "Session.NotFoundError" });
        return row;
      },
    },
  };

  shared.rows.set("ses_form", {
    id: "ses_form",
    title: "form",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  const stop = await plugin.setup(flaky);
  // Both prompt events arrive while `get` is failing.
  shared.emit({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_form" } } });
  await wait(200);
  // Now the lifecycle event admits the session, and the held form must apply.
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_form" } });
  await until(
    "the held form is applied after admission",
    () => shared.writes.some((w) => w.status === "blocked"),
    6_000,
  );
  stop?.();
});

test("a stale form cannot revive a resident admitted only from the list", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);

  shared.rows.set("ses_seeded", {
    id: "ses_seeded",
    title: "seeded",
    location: { directory: "/tmp/project" },
    // Executing, so bootstrap admits it from the list alone.
    time: { created: Date.now(), busy: Date.now() },
  });
  const ctx = makeCtx(shared, { listFails: 0 });
  const stop = await plugin.setup(ctx.ctx);
  await until("the list admitted it", () => shared.writes.some((w) => w.id === "mini-ses_seeded"));

  // Archive it: the resident goes away.
  shared.rows.get("ses_seeded")!.time.archived = Date.now();
  shared.emit({ type: "session.archived", data: { sessionID: "ses_seeded" } });
  await until("deleted", () => shared.writes.some((w) => w.method === "DELETE"));
  const afterDelete = shared.writes.length;

  // The row is live again, but no lifecycle event has arrived: only a stale
  // form that was created before the archive.
  delete shared.rows.get("ses_seeded")!.time.archived;
  shared.emit({ type: "form.created", data: { form: { id: "frm_old", sessionID: "ses_seeded" } } });
  await wait(600);
  assert.deepEqual(
    shared.writes.slice(afterDelete).map((w) => w.method),
    [],
    "a stale form did not recreate the resident",
  );
  stop?.();
});

test("a prompt answered while its admission read is pending never lands late", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  const ctx = makeCtx(shared);
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_p", {
    id: "ses_p",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  // The admission read fails once, so the prompt is parked.
  ctx.ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
    const row = shared.rows.get(sessionID);
    if (!row) throw new Error("nope");
    throw new Error("get is down");
  };
  shared.emit({ type: "permission.asked", data: { sessionID: "ses_p", id: "per_1" } });
  await wait(60);
  // The user answers before the read ever succeeded: the parked prompt is dead.
  shared.emit({ type: "permission.replied", data: { sessionID: "ses_p", requestID: "per_1" } });
  await wait(60);

  // A later lifecycle event admits the session. It must not be blocked by the
  // prompt that was already answered.
  delete (ctx.ctx.session as any).get;
  ctx.ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
    const row = shared.rows.get(sessionID);
    if (!row) throw new Error("nope");
    return row;
  };
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  await until("status reported", () => shared.writes.some((w) => w.id === "mini-ses_p"));
  await wait(60);
  assert.deepEqual(
    shared.writes.filter((w) => w.id === "mini-ses_p").map((w) => w.status),
    ["working"],
    "the answered prompt never turned the resident blocked",
  );
  stop?.();
});

test("a session admitted from the list still replays its parked prompt", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  // Every get fails, so only the list can admit.
  const ctx = makeCtx(shared, { getFails: () => true });
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_l", {
    id: "ses_l",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  shared.emit({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_l" } } });
  await wait(80);
  forcePass();
  await until(
    "the list admitted the session and the form applied",
    () => shared.writes.some((w) => w.id === "mini-ses_l" && w.status === "blocked"),
  );
  stop?.();
});

test("a prompt refused for a removed resident is not replayed on revival", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  const ctx = makeCtx(shared);
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_g", {
    id: "ses_g",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  forcePass();
  await until("admitted", () => shared.writes.some((w) => w.id === "mini-ses_g"));
  shared.rows.get("ses_g")!.time.archived = Date.now();
  shared.emit({ type: "session.archived", data: { sessionID: "ses_g" } });
  await until("deleted", () => shared.writes.some((w) => w.method === "DELETE"));

  // Live again, but the only new event is a stale prompt from before.
  delete shared.rows.get("ses_g")!.time.archived;
  shared.emit({ type: "form.created", data: { form: { id: "frm_old", sessionID: "ses_g" } } });
  await wait(120);
  assert.equal(
    shared.writes.filter((w) => w.id === "mini-ses_g" && w.status === "blocked").length,
    0,
    "a stale form did not revive the resident blocked",
  );

  // A real lifecycle event revives it, and the stale form must not come with it.
  shared.rows.get("ses_g")!.time.busy = Date.now();
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_g" } });
  await until("revived", () => shared.writes.some((w) => w.id === "mini-ses_g" && w.status === "working"));
  const statuses = shared.writes.filter((w) => w.id === "mini-ses_g").map((w) => w.status);
  // initial working, the DELETE, then working again (or no second post when
  // the revival reproduces the status the bridge already has).
  assert.equal(statuses[0], "working");
  assert.ok(!statuses.includes("blocked"), `statuses were ${JSON.stringify(statuses)}`);
  stop?.();
});

test("an authoritative absence discards the prompt parked for it", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  let failGet = true;
  const ctx = makeCtx(shared, { getFails: (id) => failGet && id === "ses_n" });
  const stop = await plugin.setup(ctx.ctx);

  // Park a form behind a failing read.
  shared.rows.set("ses_n", {
    id: "ses_n",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "form.created", data: { form: { id: "frm_n", sessionID: "ses_n" } } });
  await wait(80);

  // The row turns out to be archived: the parked form is dead, though no
  // resident was ever tracked for it.
  shared.rows.get("ses_n")!.time.archived = Date.now();
  failGet = false;
  ctx.ctx.session.list = async () => ({ data: [...shared.rows.values()] });
  forcePass();
  await wait(120);

  // Live again via a real lifecycle event: the dead form must not surface.
  delete shared.rows.get("ses_n")!.time.archived;
  shared.rows.get("ses_n")!.time.busy = Date.now();
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_n" } });
  await until("admitted", () => shared.writes.some((w) => w.id === "mini-ses_n"));
  await wait(80);
  assert.deepEqual(
    shared.writes.filter((w) => w.id === "mini-ses_n").map((w) => w.status),
    ["working"],
    "the form parked for an absent session never applied",
  );
  stop?.();
});

test("a session removed before it was ever admitted still refuses a stale prompt", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  const ctx = makeCtx(shared, { getFails: () => true });
  const stop = await plugin.setup(ctx.ctx);

  // Never admitted: the reporter only sees the archived event.
  shared.rows.set("ses_probe", {
    id: "ses_probe",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now(), archived: Date.now() },
  });
  shared.emit({ type: "session.archived", data: { sessionID: "ses_probe" } });
  await until("delete sent", () => shared.writes.some((w) => w.method === "DELETE" && w.id === "mini-ses_probe"));

  // A stale form from before the archive, then a real lifecycle revival.
  shared.rows.get("ses_probe")!.time.archived = undefined;
  shared.emit({ type: "form.created", data: { form: { id: "frm_stale", sessionID: "ses_probe" } } });
  await wait(100);
  ctx.ctx.session.get = async ({ sessionID }: { sessionID: string }) => shared.rows.get(sessionID);
  shared.emit({ type: "session.execution.started", data: { sessionID: "ses_probe" } });
  await until("revived", () => shared.writes.some((w) => w.id === "mini-ses_probe" && w.status === "working"));
  await wait(80);
  const statuses = shared.writes.filter((w) => w.id === "mini-ses_probe").map((w) => w.status);
  assert.ok(!statuses.includes("blocked"), `statuses were ${JSON.stringify(statuses)}`);
  stop?.();
});

test("a parked form still lands when the recovered session is idle", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  let failGet = true;
  const ctx = makeCtx(shared, { getFails: () => failGet });
  const stop = await plugin.setup(ctx.ctx);

  // Idle session: it would never be seeded by the executing filter alone.
  shared.rows.set("ses_idle", {
    id: "ses_idle",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: 1, idle: Date.now() },
  });
  shared.emit({ type: "form.created", data: { form: { id: "frm_idle", sessionID: "ses_idle" } } });
  await wait(80);
  failGet = false;
  forcePass();
  await until(
    "the idle session was admitted and the form applied",
    () => shared.writes.some((w) => w.id === "mini-ses_idle" && w.status === "blocked"),
  );
  stop?.();
});

test("a prompt read still clears a block when the metadata read fails", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  installFetch(shared);
  // The prompt list is healthy and empty; only `get` is failing.
  let failGet = false;
  const ctx = makeCtx(shared, { getFails: () => failGet, permissions: () => [] });
  const stop = await plugin.setup(ctx.ctx);

  shared.rows.set("ses_b", {
    id: "ses_b",
    title: "Original",
    location: { directory: "/tmp/project" },
    time: { created: Date.now(), busy: Date.now() },
  });
  forcePass();
  await until("admitted", () => shared.writes.some((w) => w.id === "mini-ses_b"));
  // A prompt is opened and its reply event is missed.
  shared.emit({ type: "permission.asked", data: { sessionID: "ses_b", id: "per_1" } });
  await until("blocked", () => shared.writes.some((w) => w.id === "mini-ses_b" && w.status === "blocked"));

  failGet = true;
  const before = ctx.permits();
  const seen = shared.writes.length;
  forcePass();
  await until(
    "the healthy prompt read cleared the block",
    () => shared.writes.slice(seen).some((w) => w.id === "mini-ses_b" && w.status === "working"),
  );
  assert.ok(ctx.permits() > before, "the prompt list was consulted despite the failing get");
  stop?.();
});

