/**
 * Ordering tests for the reporter's event/read races.
 *
 * These use a barrier harness: every emitted event is acknowledged once the
 * reporter's stream has consumed everything up to and including it, so a test
 * can interleave an event with a gated read deterministically instead of hoping
 * a timer wins a race. The barrier deliberately promises only stream
 * consumption, not task completion: the target event's handler is enqueued by
 * then, which is exactly the ordering point these races turn on. Assertions
 * therefore run after `idle()`, never right after `emit()`.
 *
 * Each case below was a real defect found in review; the assertion states the
 * correct behaviour, so it fails on the code that had the defect.
 */
import assert from "node:assert/strict";
import test from "node:test";

import plugin, { stopAllReporters } from "./index.ts";

process.env.AGENT_MACHI_INGEST_TOKEN ??= "fake-only";

const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const step = () => new Promise((resolve) => setImmediate(resolve));

async function until(label: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (check()) return;
    await step();
  }
  assert.fail(label);
}

function gate() {
  return Promise.withResolvers<void>();
}

const notFound = () => {
  throw { _tag: "Session.NotFoundError" };
};

const DIRECTORY = "/fake/a";

interface Row {
  id: string;
  title?: string;
  parentID?: string;
  location: { directory: string };
  time: { busy?: number; idle?: number; archived?: number };
}

const row = (title = "original", status: "idle" | "working" | "archived" = "idle", id = "s"): Row => ({
  id,
  title,
  location: { directory: DIRECTORY },
  time:
    status === "working"
      ? { busy: Date.now() + 100 }
      : status === "archived"
        ? { archived: Date.now() }
        : { busy: Date.now(), idle: Date.now() + 100 },
});

interface Harness {
  /** Bridge writes for this resident, as `[status, name]` or `["DELETE"]`. */
  writes(): Array<string[]>;
  /** Emit an event and wait until the queue has processed it. */
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
  setup(options?: {
    get?: (sessionID: string) => Promise<any>;
    list?: () => Promise<any>;
    permissions?: () => Promise<any>;
    dir?: string;
  }): Promise<() => void>;
  /** The live reporter, for observing internal bookkeeping. */
  reporter(): any;
  /** Wait for a pass and the queue to go idle. */
  idle(): Promise<void>;
  pass(): void;
}

function harness(): Harness {
  stopAllReporters();
  const listeners = new Set<(event: any) => void>();
  const written: Array<{ method?: string; url: string; body: any }> = [];
  let count = 0;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    written.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  const reporter = (): any => [...((globalThis as any)[Symbol.for("agent-machi.reporter")] as Map<string, any>).values()][0];
  return {
    reporter,
    writes: () =>
      written
        .filter((w) => w.body?.id === "probe-s" || new URL(w.url).searchParams.get("id") === "probe-s")
        .map((w) => (w.body ? [w.body.status, w.body.name ?? ""] : ["DELETE"])),
    emit: async (type, data = {}) => {
      const done = gate();
      for (const listener of listeners) listener({ type, data: { sessionID: "s", ...data } });
      // The barrier is a real event, so it is pulled from the stream only after
      // the target event has been consumed and its handler enqueued. Resolving
      // here means "the stream is past it", not "the task ran".
      for (const listener of listeners) listener({ type: "probe.barrier", data: { done: done.resolve } });
      await done.promise;
    },
    setup: async ({ get = async () => row(), list = async () => [], permissions = async () => [], dir = DIRECTORY } = {}) =>
      plugin.setup({
        options: { bridgeUrl: "http://127.0.0.1:9/town", machineId: "probe" },
        location: { directory: dir },
        session: { get: ({ sessionID }: { sessionID: string }) => get(sessionID), list },
        permission: { list: ({ sessionID }: { sessionID: string }) => permissions(sessionID) },
        event: {
          async *subscribe({ signal }: { signal: AbortSignal }) {
            const queue: any[] = [];
            let ready = gate();
            const listener = (event: any) => {
              queue.push(event);
              ready.resolve();
            };
            listeners.add(listener);
            const abort = () => {
              listeners.delete(listener);
              ready.resolve();
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
              while (!signal.aborted) {
                if (queue.length === 0) {
                  await ready.promise;
                  ready = gate();
                  continue;
                }
                const event = queue.shift();
                if (event.type === "probe.barrier") event.data.done();
                else yield event;
              }
            } finally {
              listeners.delete(listener);
            }
          },
        },
      } as any),
    idle: async () => {
      await until("reporter idle", () => !reporter().draining && !reporter().passRunning);
      await pause();
    },
    pass: () => reporter().runPass(),
  };
}

test("a parked start never overwrites a newer end", async () => {
  const w = harness();
  const getGate = gate();
  const promptGate = gate();
  let gets = 0;
  let prompts = 0;
  await w.setup({
    get: async () => {
      gets += 1;
      if (gets === 1) return row();
      if (gets === 2) await getGate.promise;
      throw new Error("transient");
    },
    permissions: async () => {
      prompts += 1;
      if (prompts === 1) await promptGate.promise;
      throw new Error("transient");
    },
  });
  await w.emit("session.created");
  await w.idle();
  w.pass();
  await until("get in flight", () => gets === 2);
  await w.emit("session.execution.started");
  getGate.resolve();
  await until("permissions in flight", () => prompts === 1);
  // The run is over before the prompt read returns; every read then fails, so
  // the fallback is the only thing that could publish the stale start.
  await w.emit("session.execution.succeeded");
  promptGate.resolve();
  await w.idle();

  // The end and the truth agree, so nothing new is reported: a `working` here
  // would be a run that had already finished.
  assert.deepEqual(w.writes(), [["idle", "original"]]);
  stopAllReporters();
});

test("a removal discards the prompt parked for it, so a revival starts clean", async () => {
  for (const explicitEvent of [true, false]) {
    const w = harness();
    const checked = gate();
    let gets = 0;
    let prompts = 0;
    let current: Row | null = row();
    await w.setup({
      get: async () => {
        gets += 1;
        return current ?? notFound();
      },
      permissions: async () => {
        prompts += 1;
        if (prompts === 1) await checked.promise;
        throw new Error("transient");
      },
    });
    await w.emit("session.created");
    await w.idle();
    w.pass();
    await until("prompt list in flight", () => prompts === 1);
    await w.emit("permission.asked", { id: "old" });
    // Gone either way: an explicit event, or the read proving it.
    current = null;
    if (explicitEvent) await w.emit("session.archived");
    checked.resolve();
    await w.idle();
    // A genuine revival must not inherit the ask from the previous incarnation.
    current = row("revived");
    await w.emit("session.created");
    await w.idle();
    w.pass();
    await w.idle();

    assert.deepEqual(
      w.writes(),
      [["idle", "original"], ["DELETE"], ["idle", "revived"]],
      `explicit event: ${explicitEvent}`,
    );
    stopAllReporters();
  }
});

test("a survivor with no prompt reader applies the ask instead of stranding it", async () => {
  const w = harness();
  const checked = gate();
  let prompts = 0;
  let gets = 0;
  const stop = await w.setup({
    permissions: async () => {
      prompts += 1;
      await checked.promise;
      return [];
    },
  });
  // A second location joins, so the reporter survives the first one unloading.
  await w.setup({ dir: "/fake/b", get: async () => (gets += 1, row()), list: async () => [row()] });
  await w.emit("session.created");
  await w.idle();
  w.pass();
  await until("prompt list in flight", () => prompts === 1);
  await w.emit("permission.asked", { id: "still-open" });
  stop();
  checked.resolve();
  await w.idle();
  w.pass();
  await w.idle();

  // The survivor cannot read this session's location, so waiting for a reader
  // that may never return would strand the ask forever.
  assert.deepEqual(w.writes(), [["idle", "original"], ["blocked", "original"]]);
  stopAllReporters();
});

test("an answered prompt is never reported blocked by a failing recheck", async () => {
  const w = harness();
  const first = gate();
  const second = gate();
  const unrelated = gate();
  let prompts = 0;
  let otherGets = 0;
  await w.setup({
    get: async (id: string) => {
      if (id !== "s") {
        otherGets += 1;
        await unrelated.promise;
        return notFound();
      }
      return row();
    },
    permissions: async () => {
      prompts += 1;
      await (prompts === 1 ? first.promise : second.promise);
      throw new Error("transient");
    },
  });
  await w.emit("session.created");
  await w.idle();
  w.pass();
  await until("first prompt read", () => prompts === 1);
  await w.emit("permission.asked", { id: "old" });
  first.resolve();
  await until("second prompt read", () => prompts === 2);
  // The answer arrives while an unrelated admission holds the queue.
  await w.emit("session.created", { sessionID: "other" });
  await w.emit("permission.replied", { requestID: "old" });
  second.resolve();
  await until("unrelated read", () => otherGets === 1);
  await pause();
  unrelated.resolve();
  await w.idle();

  assert.deepEqual(w.writes(), [["idle", "original"]]);
  stopAllReporters();
});

test("a child's raced start parks nothing", async () => {
  const w = harness();
  const checked = gate();
  let gets = 0;
  await w.setup({
    get: async () => {
      gets += 1;
      if (gets === 1) await checked.promise;
      return { ...row(), parentID: "parent" };
    },
  });
  await w.emit("session.created");
  await until("child admission read", () => gets === 1);
  await w.emit("session.execution.started");
  checked.resolve();
  await w.idle();
  await w.emit("session.execution.succeeded");
  await w.emit("session.deleted");
  await w.idle();
  w.pass();
  await w.idle();

  assert.deepEqual(w.writes(), [["DELETE"]]);
  const reporter = [...((globalThis as any)[Symbol.for("agent-machi.reporter")] as Map<string, any>).values()][0];
  assert.equal(reporter.pendingExec.size, 0, "a child left a parked execution event behind");
  stopAllReporters();
});

test("an ask that arrives after the archive cannot be parked for the next incarnation", async () => {
  const w = harness();
  const checked = gate();
  let prompts = 0;
  await w.setup({
    permissions: async () => {
      prompts += 1;
      await checked.promise;
      throw new Error("transient");
    },
  });
  await w.emit("session.created");
  await w.idle();
  w.pass();
  await until("prompt list in flight", () => prompts === 1);
  // The archive removes the resident, and the ask arrives while the prompt read
  // that raced it is still pending.
  await w.emit("session.archived");
  await w.emit("permission.asked", { id: "late" });
  checked.resolve();
  await w.idle();

  // A revival is a new resident: the ask from the old one must not follow it.
  await w.emit("session.created");
  await w.idle();
  w.pass();
  await w.idle();

  assert.deepEqual(
    w.writes(),
    [["idle", "original"], ["DELETE"], ["idle", "original"]],
    "the old ask blocked the revived resident",
  );
  stopAllReporters();
});

test("a survivor without a prompt reader still applies the ask when the row read fails", async () => {
  const w = harness();
  const checked = gate();
  let prompts = 0;
  let survivorGets = 0;
  const stop = await w.setup({
    permissions: async () => {
      prompts += 1;
      await checked.promise;
      return [];
    },
  });
  // The survivor owns another location and can only see this session's metadata.
  await w.setup({
    dir: "/fake/b",
    get: async () => {
      survivorGets += 1;
      throw new Error("transient");
    },
    list: async () => [],
  });
  await w.emit("session.created");
  await w.idle();
  w.pass();
  await until("prompt list in flight", () => prompts === 1);
  await w.emit("permission.asked", { id: "stranded" });
  stop();
  checked.resolve();
  await w.idle();
  w.pass();
  await w.idle();
  w.pass();
  await w.idle();

  // The survivor never gets a good metadata read, but the ask is still the only
  // evidence that a prompt exists: it must be reported, not waited on forever.
  assert.deepEqual(w.writes(), [["idle", "original"], ["blocked", "original"]]);
  assert.ok(survivorGets >= 1, "the survivor never attempted the read");
  stopAllReporters();
});

test("a newer end that has not run yet still outranks a parked start", async () => {
  const w = harness();
  const firstRead = gate();
  const recheckRead = gate();
  let gets = 0;
  await w.setup({
    get: async () => {
      gets += 1;
      if (gets === 1) return row();
      if (gets === 2) await firstRead.promise;
      if (gets === 3) await recheckRead.promise;
      throw new Error("transient");
    },
    permissions: async () => {
      throw new Error("transient");
    },
  });
  await w.emit("session.created");
  await w.idle();
  w.pass();
  await until("reconcile read in flight", () => gets === 2);
  // The start arrives during the read, so it is parked.
  await w.emit("session.execution.started");
  firstRead.resolve();
  // The start's queued task now runs: its own admission read fails (3), so it
  // parks and asks for a recheck.
  await until("recheck read in flight", () => gets === 3);
  // The run ends while that recheck is still reading. The end's handler will not
  // run until the read returns, but the end is already a fact.
  await w.emit("session.execution.succeeded");
  recheckRead.resolve();
  await w.idle();

  // The recheck cannot answer, so the parked start would otherwise be flushed.
  // A run that already ended must never be announced afterwards.
  assert.deepEqual(w.writes(), [["idle", "original"]]);
  stopAllReporters();
});

test("a snapshot cannot clear an ask that arrived after it began", async () => {
  const w = harness();
  const snapshot = gate();
  let prompts = 0;
  await w.setup({
    get: async () => row(),
    permissions: async () => {
      prompts += 1;
      // 1: the snapshot the pass reads. It can only ever see `per_old`, because
      // `per_new` arrives after it began.
      if (prompts === 1) {
        await snapshot.promise;
        return ["per_old"];
      }
      return [];
    },
  });
  await w.emit("session.created");
  await w.idle();
  await w.emit("permission.asked", { id: "per_old" });
  await w.idle();
  w.pass();
  await until(
    "snapshot in flight",
    () => prompts === 1 && (w.reporter()?.readingPrompts.size ?? 0) === 1,
  );
  // `per_new` is open and the snapshot cannot see it. `per_old` is answered in
  // the meantime, so filtering answered ids alone would leave an empty set and
  // report the resident idle while it is still waiting on `per_new`.
  await w.emit("permission.asked", { id: "per_new" });
  await w.emit("permission.replied", { requestID: "per_old" });
  snapshot.resolve();
  await w.idle();

  const statuses = w.writes().map((write) => write[0]);
  assert.ok(
    !statuses.slice(1).includes("idle"),
    `an open ask was cleared: ${statuses.join(",")}`,
  );
  stopAllReporters();
});
