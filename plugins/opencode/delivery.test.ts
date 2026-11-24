import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelivery, residentID, retryAfterMs, type DeliveryConfig } from "./delivery.ts";

// Pacing is per report endpoint and lanes are shared process-wide, so each test
// gets its own endpoint: otherwise one test's outage window opens on the next.
let endpoint = 0;
const base = (): DeliveryConfig => ({
  bridgeUrl: new URL(`http://127.0.0.1:9/e${++endpoint}/`),
  token: "t",
  source: "opencode",
  agent: "opencode",
  machineId: "mini",
});

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
  const delivery = createDelivery({ ...base(), fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working", name: "town" });
  await delivery.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `http://127.0.0.1:9/e${endpoint}/report`);
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
  const delivery = createDelivery({ ...base(), fetch });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  await delivery.drain();
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, `http://127.0.0.1:9/e${endpoint}/report?source=opencode&id=mini-ses_a`);
  assert.equal(calls[0].body, null);
});

test("a newer status replaces an unsent one", async () => {
  const { calls, fetch } = recorder();
  const delivery = createDelivery({ ...base(), fetch });
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
  const delivery = createDelivery({ ...base(), fetch });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  await delivery.drain();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["DELETE"],
  );
});

test("a session that comes back while its delete is backing off is reported again", async () => {
  // The DELETE is the request that fails, so the POST really does supersede a
  // DELETE that has not been accepted yet.
  const { calls, fetch } = recorder((url) => (url.includes("?") ? 503 : 200));
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 10 });
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await delivery.drain();
  assert.equal(calls[0].method, "DELETE", "the delete was attempted first");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("a fresh write after a failing one is still sent", async () => {
  // Only the first request fails: the point is that the replacement write is not
  // discarded just because the write it superseded had already spent attempts.
  const { calls, fetch } = recorder((_url, attempt) => (attempt === 1 ? 503 : 200));
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 10 });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  delivery.enqueue({ type: "delete", sessionID: "ses_a" });
  await delivery.drain();
  assert.ok(calls.some((call) => call.method === "DELETE"), "the delete was sent");
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
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 60_000 });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  delivery.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  settled = true;
  assert.equal(aborted, true, "the in-flight request was cancelled");
});

test("a failing write does not stop another session from being sent", async () => {
  const seen: string[] = [];
  let firstFailure = true;
  const fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const id = body.id ?? url.searchParams.get("id") ?? "";
    seen.push(id);
    // One failure from ses_a opens the outage window; after that the bridge is
    // healthy again.
    if (firstFailure) {
      firstFailure = false;
      return new Response("nope", { status: 503 });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 50 });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  delivery.enqueue({ type: "post", sessionID: "ses_b", status: "working" });
  // Pacing is endpoint-wide, so ses_b waits out the shared outage window, but
  // it is still sent without waiting for ses_a's whole retry schedule.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.ok(seen.includes("mini-ses_b"), "ses_b was sent despite ses_a failing");
  delivery.close();
});

test("a stalled bridge is cancelled at the deadline, not left hanging", async () => {
  let aborted = false;
  const fetch = ((_input: any, init: any = {}) => {
    const signal: AbortSignal | undefined = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
      // Headers never arrive: only the deadline can end this.
    });
  }) as unknown as typeof globalThis.fetch;
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 25 });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(aborted, true, "the deadline aborted the stalled request");
  delivery.close();
});

test("drain after close resolves instead of starting a keep-alive", async () => {
  // An aborted fetch that rejects promptly: the point is that drain() returns
  // even though close() already ran, not that a hung promise can be collected.
  const fetch = ((_input: any, init: any = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof globalThis.fetch;
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 60_000 });
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  delivery.close();
  await delivery.drain();
  assert.ok(true);
});

test("alternating states do not reset the outage backoff", async () => {
  let requests = 0;
  const fetch = (async () => {
    requests += 1;
    return new Response("nope", { status: 503 });
  }) as unknown as typeof globalThis.fetch;
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 10 });
  // Flip between two states under a sustained outage. Each flip is "new work",
  // but the outage has not changed, so the delay must keep growing.
  for (let i = 0; i < 8; i += 1) {
    delivery.enqueue({ type: "post", sessionID: "ses_a", status: i % 2 === 0 ? "working" : "idle" });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  // Eight flips in ~half a second: with exponential pacing only the first few
  // requests can go out. Without it, every flip would be attempted at once.
  assert.ok(requests <= 5, `backoff was respected (${requests} requests)`);
  delivery.close();
});

test("outage pacing is endpoint-wide, not per resident", async () => {
  const stamps: number[] = [];
  const fetch = (async () => {
    stamps.push(Date.now());
    return new Response("nope", { status: 503 });
  }) as unknown as typeof globalThis.fetch;
  const delivery = createDelivery({ ...base(), fetch, timeoutMs: 50 });
  const started = Date.now();
  delivery.enqueue({ type: "post", sessionID: "ses_a", status: "working" });
  delivery.enqueue({ type: "post", sessionID: "ses_b", status: "working" });
  delivery.enqueue({ type: "post", sessionID: "ses_c", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  // The first failure opens a one-second window; the other two must not slip
  // inside it.
  assert.equal(stamps.length, 1, `saw ${stamps.length} requests inside the outage window`);
  assert.ok(stamps[0] - started < 300);
  delivery.close();
});

test("a shared lane sends each write with its own reporter's identity", async () => {
  const seen: string[] = [];
  const held: Array<() => void> = [];
  const fetch = (async (input: any, init: any = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const url = new URL(String(input));
    seen.push(body.id ?? url.searchParams.get("id") ?? "");
    // Hold the first response so both writes start before either settles.
    if (seen.length === 1) await new Promise<void>((resolve) => held.push(resolve));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const lane = `http://127.0.0.1:9/lane${++endpoint}/`;
  const alpha = createDelivery({ ...base(), bridgeUrl: new URL(lane), fetch, machineId: "alpha" });
  const beta = createDelivery({ ...base(), bridgeUrl: new URL(lane), fetch, machineId: "beta" });
  alpha.enqueue({ type: "post", sessionID: "a", status: "working" });
  beta.enqueue({ type: "post", sessionID: "b", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const release of held) release();
  await alpha.drain();
  await beta.drain();
  assert.deepEqual(seen.sort(), ["alpha-a", "beta-b"]);
  alpha.close();
  beta.close();
});

test("unloading one reporter does not strand a survivor's queued write", async () => {
  const calls: string[] = [];
  const fetch = (async (input: any, init: any = {}) => {
    calls.push(init.method ?? "GET");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const lane = `http://127.0.0.1:9/lane${++endpoint}/`;
  const alpha = createDelivery({ ...base(), bridgeUrl: new URL(lane), fetch, machineId: "alpha" });
  const beta = createDelivery({ ...base(), bridgeUrl: new URL(lane), fetch, machineId: "beta" });
  beta.enqueue({ type: "post", sessionID: "b", status: "working" });
  alpha.close();
  await beta.drain();
  assert.deepEqual(calls, ["POST"], "the survivor's write still went out");
  beta.close();
});

test("closing one machine id never aborts a longer machine id's write", async () => {
  const aborted: string[] = [];
  const held: Array<() => void> = [];
  const fetch = (async (_input: any, init: any = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    await new Promise<void>((resolve) => held.push(resolve));
    if (init.signal?.aborted) aborted.push(body.id);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const lane = `http://127.0.0.1:9/lane${++endpoint}/`;
  const short = createDelivery({ ...base(), bridgeUrl: new URL(lane), fetch, machineId: "mini" });
  const long = createDelivery({ ...base(), bridgeUrl: new URL(lane), fetch, machineId: "mini-lab" });
  long.enqueue({ type: "post", sessionID: "b", status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  short.close();
  for (const release of held) release();
  await long.drain();
  assert.deepEqual(aborted, [], "mini-lab's request was not aborted by mini's unload");
  long.close();
});

test("an HTTP-date Retry-After is parsed as a delay, not as seconds", () => {
  // Parsed directly rather than through a timed retry: the point is which form
  // `Retry-After` can take, and a wall-clock assertion here would be flaky under
  // a parallel test run.
  // An HTTP-date is only precise to the second, so the target is well clear of
  // the default one-second backoff rather than just above it.
  const inFiveSeconds = new Date(Date.now() + 5_000).toUTCString();
  const response = new Response(null, { status: 429, headers: { "retry-after": inFiveSeconds } });
  const delay = retryAfterMs(response);
  assert.ok(delay !== undefined && delay > 3_000, `delay was ${delay}`);
  const seconds = new Response(null, { status: 429, headers: { "retry-after": "3" } });
  assert.equal(retryAfterMs(seconds), 3_000);
  const past = new Response(null, { status: 429, headers: { "retry-after": new Date(Date.now() - 5_000).toUTCString() } });
  assert.equal(retryAfterMs(past), undefined);
  // The server's hint is not clamped to this client's own backoff ceiling:
  // shortening it would only earn another 429.
  const long = new Response(null, { status: 429, headers: { "retry-after": "120" } });
  assert.equal(retryAfterMs(long), 120_000);
});
