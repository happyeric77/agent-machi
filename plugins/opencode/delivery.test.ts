import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelivery, residentID, type DeliveryConfig } from "./delivery.ts";

const base: DeliveryConfig = {
  bridgeUrl: new URL("http://127.0.0.1:9/"),
  token: "t",
  source: "opencode",
  agent: "opencode",
  machineId: "mini",
};

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

function recorder(handler?: (url: string, attempt: number) => number | "throw") {
  const calls: Recorded[] = [];
  let attempts = 0;
  const fetch = async (input: any, init: any = {}) => {
    attempts += 1;
    calls.push({
      method: init.method ?? "GET",
      url: String(input),
      headers: init.headers ?? {},
      body: init.body ?? null,
    });
    const verdict = handler?.(String(input), attempts) ?? 200;
    if (verdict === "throw") throw new Error("network down");
    return new Response(verdict === 200 ? '{"ok":true}' : "nope", { status: verdict });
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

test("resident id requires a printable machine id and stays under the byte cap", () => {
  assert.equal(residentID("mini", "ses_abc"), "mini-ses_abc");
  assert.equal(residentID("mini", "a:b"), null);
  assert.equal(residentID("min i", "ses"), null);
  assert.equal(residentID("mini", "x".repeat(124)), null);
  assert.equal(residentID("mini", "x".repeat(123)), "mini-" + "x".repeat(123));
});

test("a post targets /report with the bearer token and the resident id", async () => {
  const { calls, fetch } = recorder();
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working", name: "town" });
  await delivery.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://127.0.0.1:9/report");
  assert.equal(calls[0].headers.Authorization, "Bearer t");
  assert.deepEqual(JSON.parse(calls[0].body ?? "{}"), {
    source: "opencode",
    id: "mini-ses_a",
    status: "working",
    agent: "opencode",
    name: "town",
  });
});

test("a delete uses query params, not a body", async () => {
  const { calls, fetch } = recorder();
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  await delivery.drain();
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, "http://127.0.0.1:9/report?source=opencode&id=mini-ses_a");
  assert.equal(calls[0].body, null);
});

test("a newer status replaces an unsent one", async () => {
  const { calls, fetch } = recorder();
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "idle" });
  await delivery.drain();
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.body ?? "{}").status),
    ["idle"],
  );
});

test("a delete supersedes a queued post for the same session", async () => {
  const { calls, fetch } = recorder();
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  await delivery.drain();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["DELETE"],
  );
});

test("a session that comes back while its delete is backing off is reported again", async () => {
  const { calls, fetch } = recorder((_url, attempt) => (attempt === 1 ? 503 : 200));
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 10 });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  // The reducer only posts again after a real start, so this supersedes the
  // delete that has not been accepted yet.
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await delivery.drain();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "POST"],
  );
});

test("a 4xx is dropped without retrying", async () => {
  const { calls, fetch } = recorder(() => 400);
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await delivery.drain();
  assert.equal(calls.length, 1);
});

test("a network failure schedules a retry instead of throwing", async () => {
  const { calls, fetch } = recorder(() => "throw");
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  // The queue keeps a backed-off entry, so do not wait for drain() here.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 1, "the first retry is scheduled, not immediate");
});

test("a 5xx retries and then succeeds", async () => {
  const { calls, fetch } = recorder((_url, attempt) => (attempt < 3 ? 503 : 200));
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await delivery.drain();
  assert.equal(calls.length, 3);
});

test("a bridge URL with a path prefix keeps the prefix", async () => {
  const { calls, fetch } = recorder();
  const delivery = createDelivery({ ...base, bridgeUrl: new URL("http://127.0.0.1:9/town"), fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await delivery.drain();
  assert.equal(calls[0].url, "http://127.0.0.1:9/town/report");
});

test("a resident id the bridge would reject is never sent", async () => {
  const { calls, fetch } = recorder();
  const delivery = createDelivery({ ...base, machineId: "bad id", fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  await delivery.drain();
  assert.equal(calls.length, 0);
});

test("a state that arrives while a delete is in flight survives", async () => {
  let release: (() => void) | null = null;
  const calls: string[] = [];
  const fetch = async (_input: any, init: any = {}) => {
    calls.push(init.method ?? "GET");
    if (init.method === "DELETE") await new Promise<void>((resolve) => (release = resolve));
    return new Response("{}", { status: 200 });
  };
  const delivery = createDelivery({ ...base, fetch: fetch as unknown as typeof globalThis.fetch });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  // Let the DELETE start, then reactivate the resident while it is in flight.
  await new Promise((resolve) => setTimeout(resolve, 20));
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  release?.();
  await delivery.drain();
  assert.deepEqual(calls, ["DELETE", "POST"]);
});

test("close stops the writer without keeping the process alive", async () => {
  const { calls, fetch } = recorder(() => "throw");
  const delivery = createDelivery({ ...base, fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  delivery.close();
  const before = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(calls.length, before, "no write is attempted after close");
});

test("close aborts an in-flight request and nothing lands afterwards", async () => {
  let aborted = false;
  let settled = false;
  const fetch = ((_input: any, init: any = {}) => {
    const signal: AbortSignal | undefined = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
      // Never resolves on its own: only the abort ends it.
      void settled;
    });
  }) as unknown as typeof globalThis.fetch;
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 60_000 });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  delivery.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  settled = true;
  assert.equal(aborted, true, "the in-flight request was cancelled");
});

test("a ready write for another session is not delayed by a retry timer", async () => {
  const seen: string[] = [];
  const fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const id = body.id ?? url.searchParams.get("id") ?? "";
    seen.push(id);
    // ses_a fails once so a retry timer exists; ses_b must not wait for it.
    if (id === "mini-ses_a") return new Response("nope", { status: 503 });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 50 });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  delivery.enqueue({ type: "post", sessionID: "ses_b", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(seen.includes("mini-ses_b"), "ses_b was sent without waiting for ses_a's backoff");
  delivery.close();
});
