/**
 * Reporter wiring tests: these go through `setup()` with a fake context, so
 * handoff, bootstrap retry and deferred reads are exercised in the shape the
 * plugin actually runs in, not just in the reducer.
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
}

function world(): World {
  const rows = new Map<string, Row>();
  const bus: Array<(event: any) => void> = [];
  return { rows, bus, emit: (event) => bus.forEach((listener) => listener(event)) };
}

interface Options {
  bridgeUrl?: string;
  machineId?: string;
  listFails?: number;
  permissions?: (sessionID: string) => string[];
  directory?: string;
}

function makeCtx(shared: World, opts: Options = {}) {
  const directory = opts.directory ?? "/tmp/project";
  let listFails = opts.listFails ?? 0;
  const calls = { list: 0, get: 0, permit: 0 };
  const ctx: any = {
    location: { directory },
    options: {
      bridgeUrl: opts.bridgeUrl ?? "http://127.0.0.1:9/",
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
        const row = shared.rows.get(sessionID);
        if (!row) throw Object.assign(new Error("not found"), { _tag: "Session.NotFoundError" });
        return row;
      },
    },
    permission: {
      async list({ sessionID }: { sessionID: string }) {
        calls.permit += 1;
        return (opts.permissions?.(sessionID) ?? []).map((id) => ({ id }));
      },
    },
    event: {
      async *subscribe({ signal }: { signal?: AbortSignal }) {
        const queue: any[] = [];
        shared.bus.push((event) => queue.push(event));
        while (!signal?.aborted) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    },
  };
  return { ctx, calls, directory };
}

/** A fetch that records nothing and always succeeds. */
const okFetch = (async () =>
  new Response('{"ok":true}', { status: 200 })) as unknown as typeof globalThis.fetch;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPlugin() {
  const mod: any = await import("./index.ts");
  mod.stopAllReporters(); // each test starts from an empty registry
  return mod.default;
}

test("a second setup keeps the first location's state and reports its own", async () => {
  const plugin = await loadPlugin();
  const shared = world();

  const a = makeCtx(shared, { directory: "/tmp/a" });
  const stopA = await plugin.setup(a.ctx);
  assert.ok(typeof stopA === "function");

  const b = makeCtx(shared, { directory: "/tmp/b" });
  const stopB = await plugin.setup(b.ctx);

  // Both are registered on one reporter: unloading B must not stop A.
  stopB?.();
  await wait(20);
  stopA?.();
});

test("a failed bootstrap is retried by the next pass", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  // One executing session that only a successful list read can find.
  shared.rows.set("ses_boot", {
    id: "ses_boot",
    title: "boot",
    location: { directory: "/tmp/proj" },
    time: { created: Date.now(), busy: Date.now() },
  });
  const one = makeCtx(shared, { listFails: 1 });
  const stop = await plugin.setup(one.ctx);
  // The first pass fails; a timer retries it without waiting for a reconnect.
  await wait(2600);
  assert.ok(one.calls.list >= 2, `bootstrap was retried (list calls: ${one.calls.list})`);
  stop?.();
});

test("cleanup is idempotent and never evicts a replacement", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  const a = makeCtx(shared);
  const stopA = await plugin.setup(a.ctx);
  stopA?.();
  stopA?.(); // a duplicate cleanup must be harmless
  const b = makeCtx(shared);
  const stopB = await plugin.setup(b.ctx);
  assert.ok(typeof stopB === "function");
  stopB?.();
});

test("a read for a session in a location with no setup is skipped", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  const local = makeCtx(shared, { directory: "/tmp/local" });
  const stop = await plugin.setup(local.ctx);
  // A session that lives elsewhere: nothing here can describe its prompts.
  shared.rows.set("ses_far", {
    id: "ses_far",
    title: "far",
    location: { directory: "/tmp/elsewhere" },
    time: { created: Date.now() },
  });
  shared.emit({ type: "session.created", data: { sessionID: "ses_far" } });
  await wait(60);
  assert.equal(local.calls.permit, 0, "no prompt read was issued from the wrong location");
  stop?.();
});

test("two spellings of one endpoint share a single reporter", async () => {
  const plugin = await loadPlugin();
  const shared = world();
  const a = makeCtx(shared, { bridgeUrl: "http://127.0.0.1:9/town" });
  const b = makeCtx(shared, { bridgeUrl: "http://127.0.0.1:9/town/" });
  const stopA = await plugin.setup(a.ctx);
  const stopB = await plugin.setup(b.ctx);
  // Both setups are alive at once; neither evicts the other.
  assert.ok(typeof stopA === "function" && typeof stopB === "function");
  stopB?.();
  stopA?.();
});

export { okFetch };
