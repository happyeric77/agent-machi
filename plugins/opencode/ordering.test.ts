/**
 * Ordering tests for the reporter's event/read races.
 *
 * These use a barrier harness: every emitted event is acknowledged only after
 * the reporter's serial queue has drained past it, so a test can interleave an
 * event with a gated read deterministically instead of hoping a timer wins a
 * race. Each case below was a real defect found in review; the assertion states
 * the correct behaviour, so it fails on the code that had the defect.
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
    writes: () =>
      written
        .filter((w) => w.body?.id === "probe-s" || new URL(w.url).searchParams.get("id") === "probe-s")
        .map((w) => (w.body ? [w.body.status, w.body.name ?? ""] : ["DELETE"])),
    emit: async (type, data = {}) => {
      const done = gate();
      for (const listener of listeners) listener({ type, data: { sessionID: "s", ...data } });
      // The barrier is a real event: it is processed after the target event by
      // the same serial queue, so resolving here means "the queue got there".
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
