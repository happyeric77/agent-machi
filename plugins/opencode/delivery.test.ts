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
  // The DELETE is the request that fails, so the POST really does supersede a
  // DELETE that has not been accepted yet.
  const { calls, fetch } = recorder((url) => (url.includes("?") ? 503 : 200));
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 10 });
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
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 10 });
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
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 25 });
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
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 60_000 });
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
  const delivery = createDelivery({ ...base, fetch, timeoutMs: 10 });
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
