/**
 * Delivery layer: turns reducer actions into `/report` calls without ever
 * blocking the OpenCode event hook.
 *
 * The queue is per session and holds at most one desired write: the latest
 * state always wins, whatever came before it, because the reducer only emits a
 * post for a session it still tracks. A write that is already in flight is
 * never replaced; the newer state is sent after it, so the bridge always sees
 * the reducer's order. Bridge failures back off and never throw into the hook
 * that produced them.
 */

export interface DeliveryConfig {
  readonly bridgeUrl: URL;
  readonly token: string;
  readonly source: string;
  readonly agent: string;
  readonly machineId: string;
  /** Bound for a single request. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export type Write =
  | { readonly type: "post"; readonly sessionID: string; readonly status: string; readonly name?: string }
  | { readonly type: "delete"; readonly sessionID: string };

export interface Delivery {
  enqueue(write: Write): void;
  /** Resolves once nothing is queued or in flight. Used by tests. */
  drain(): Promise<void>;
  /** Drop everything, abort in-flight requests and stop: used on unload. */
  close(): void;
}

/**
 * The canonical report endpoint. Two configurations that differ only in
 * spelling (`/town` vs `/town/`) write to the same resident namespace, so
 * anything keyed by "where writes go" must use this, not the raw option.
 */
export function reportURL(bridgeUrl: URL): URL {
  const url = new URL(bridgeUrl);
  url.pathname = url.pathname.replace(/\/?$/, "/report");
  url.search = "";
  url.hash = "";
  return url;
}

/** `<machineId>-<sessionID>`, or null when the result cannot be a valid id. */
export function residentID(machineId: string, sessionID: string): string | null {
  if (!/^[!-~]+$/.test(machineId) || machineId.includes(":")) return null;
  const id = `${machineId}-${sessionID}`;
  if (id.includes(":")) return null;
  const bytes = new TextEncoder().encode(id).length;
  if (bytes < 1 || bytes > 128) return null;
  return id;
}

/** True when the two writes ask for exactly the same thing. */
function sameWrite(a: Write, b: Write): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "delete" || b.type === "delete") return true;
  return a.status === b.status && a.name === b.name;
}

const MAX_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 8;

interface Pending {
  write: Write;
  /** Attempts spent on this exact write; a different write starts at zero. */
  attempts: number;
  notBefore: number;
}

export function createDelivery(cfg: DeliveryConfig): Delivery {
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const doFetch = cfg.fetch ?? globalThis.fetch;
  /** The next write for each session; at most one per session. */
  const queue = new Map<string, Pending>();
  /** Requests on the wire, keyed by session, so one is never sent twice. */
  const inflight = new Map<string, AbortController>();
  let idle: Array<() => void> = [];
  let stopped = false;
  /** Consecutive failed requests across all writes; reset by any success. */
  let transportFailures = 0;
  /** No request at all goes out before this: pacing is endpoint-wide. */
  let outageUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When the armed timer fires; 0 when none is armed. */
  let timerDue = 0;
  /** Keeps the loop alive only while somebody awaits drain(). */
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  function settleIfIdle(): void {
    if (queue.size === 0 && inflight.size === 0) {
      // Nothing is outstanding: a drain() waiter has nothing left to wait for,
      // so the keep-alive interval must not outlive it.
      if (keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
      const waiters = idle;
      idle = [];
      for (const resolve of waiters) resolve();
    }
  }

  function enqueue(write: Write): void {
    if (stopped) return;
    // An id the bridge would reject is never sent: no truncating, no patching.
    if (residentID(cfg.machineId, write.sessionID) === null) {
      console.warn("[agent-machi] skipping a resident whose id breaks the bridge's limits");
      return;
    }
    // Latest state wins. A session coming back after a delete therefore
    // survives, and a delete still supersedes a post queued before it: the
    // reducer's order is the only order that matters here.
    const existing = queue.get(write.sessionID);
    // Same operation and same state: this is a heartbeat for work already
    // failing, so it keeps waiting out that backoff. A different write is new
    // work — a DELETE after a failing POST — and gets its own attempt budget,
    // though it may not jump the queue ahead of a retry already scheduled.
    const same = existing !== undefined && sameWrite(existing.write, write);
    queue.set(write.sessionID, {
      write,
      attempts: same ? existing.attempts : 0,
      notBefore: existing?.notBefore ?? 0,
    });
    schedule();
  }

  function schedule(): void {
    if (stopped) return;
    const next = nextDue();
    if (next === null) return;
    // An existing timer may be waiting out a long backoff while another
    // session is already due: re-arm instead of letting it wait.
    if (timer !== null) {
      if (timerDue <= next) return;
      clearTimeout(timer);
      timer = null;
    }
    timerDue = next;
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, Math.max(0, next - Date.now()));
    // A pending retry must never hold the process open on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function nextDue(): number | null {
    let due: number | null = null;
    for (const [sessionID, pending] of queue) {
      // An in-flight id cannot be sent again yet; counting its deadline spins.
      if (inflight.has(sessionID)) continue;
      if (due === null || pending.notBefore < due) due = pending.notBefore;
    }
    if (due === null) return null;
    // A fresh write for another session must not slip inside the outage
    // window: the bridge is down for everyone, not per resident.
    return Math.max(due, outageUntil);
  }

  /**
   * Send one write at a time.
   *
   * One request on the wire per endpoint makes the outage window actually
   * apply: a burst of three writes for three residents would otherwise all
   * leave before the first failure could open it. Delivery is best-effort and
   * the queue is short, so serialising costs nothing that matters.
   */
  async function pump(): Promise<void> {
    if (stopped || inflight.size > 0) return;
    const now = Date.now();
    if (outageUntil > now) {
      schedule();
      return;
    }
    let next: [string, Pending] | null = null;
    for (const entry of queue) {
      if (entry[1].notBefore > now) continue;
      next = entry;
      break;
    }
    if (next === null) {
      settleIfIdle();
      return;
    }
    const [sessionID, pending] = next;
    queue.delete(sessionID);
    const abort = new AbortController();
    inflight.set(sessionID, abort);
    void send(sessionID, pending, abort).finally(() => {
      if (inflight.get(sessionID) === abort) inflight.delete(sessionID);
      schedule();
      settleIfIdle();
    });
    schedule();
  }

  async function send(
    sessionID: string,
    pending: Pending,
    controller: AbortController,
  ): Promise<void> {
    const write = pending.write;
    // A request must never outlive its own bound, and close() must be able to
    // cancel it: one controller that fires on either.
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(requestURL(write), {
        method: write.type === "post" ? "POST" : "DELETE",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          ...(write.type === "post" ? { "Content-Type": "application/json" } : {}),
        },
        ...(write.type === "post" ? { body: JSON.stringify(body(write)) } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      retryOrDrop(sessionID, write, pending);
      return;
    } finally {
      clearTimeout(deadline);
    }
    if (response.ok) {
      // The bridge is answering: outage pacing starts over.
      transportFailures = 0;
      outageUntil = 0;
      return;
    }
    // A rejected write (bad id, wrong token, ingest off) will not be fixed by
    // retrying, but a transient 5xx or a stalled bridge might be.
    if (response.status >= 500) retryOrDrop(sessionID, write, pending);
  }

  function retryOrDrop(sessionID: string, write: Write, pending: Pending): void {
    // Unload already dropped the queue and cancelled this request.
    if (stopped) return;
    const attempts = pending.attempts + 1;
    if (attempts > MAX_ATTEMPTS) {
      // This write is out of budget. An identical queued copy is the same work
      // and goes with it; a different write (a DELETE after a failing POST) is
      // new work and keeps its own budget.
      const queued = queue.get(sessionID);
      if (queued && sameWrite(queued.write, write)) queue.delete(sessionID);
      return;
    }
    // Two separate budgets. `attempts` bounds one write; `transportFailures`
    // paces the outage. Without the second, alternating states would reset the
    // delay on every flip and hammer a bridge that is simply down.
    transportFailures += 1;
    const backoff = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (transportFailures - 1));
    const notBefore = Date.now() + backoff;
    outageUntil = Math.max(outageUntil, notBefore);
    const queued = queue.get(sessionID);
    if (queued) {
      // A newer state arrived while this one was failing. It runs into the same
      // outage, so it inherits the wait — but if it is different work (a DELETE
      // after a failing POST) it keeps its own attempt budget rather than
      // burning through the attempts the failed write already spent.
      queued.attempts = sameWrite(queued.write, write) ? Math.max(queued.attempts, attempts) : 0;
      queued.notBefore = Math.max(queued.notBefore, notBefore);
    } else {
      queue.set(sessionID, { write, attempts, notBefore });
    }
    schedule();
  }

  function requestURL(write: Write): string {
    const url = reportURL(cfg.bridgeUrl);
    if (write.type === "post") return url.toString();
    url.searchParams.set("source", cfg.source);
    url.searchParams.set("id", residentID(cfg.machineId, write.sessionID) ?? "");
    return url.toString();
  }

  function body(write: Extract<Write, { type: "post" }>): Record<string, string> {
    const payload: Record<string, string> = {
      source: cfg.source,
      id: residentID(cfg.machineId, write.sessionID) ?? "",
      status: write.status,
      agent: cfg.agent,
    };
    if (write.name) payload.name = write.name;
    return payload;
  }

  return {
    enqueue,
    close(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      // An in-flight POST could otherwise land after the replacement reporter
      // has already reported the same resident.
      for (const abort of inflight.values()) abort.abort();
      queue.clear();
      if (keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
      const waiters = idle;
      idle = [];
      for (const resolve of waiters) resolve();
    },
    drain(): Promise<void> {
      return new Promise((resolve) => {
        // Nothing will ever be sent again: a waiter would wait forever, and the
        // keep-alive interval would outlive the writer.
        if (stopped || (queue.size === 0 && inflight.size === 0)) {
          resolve();
          return;
        }
        // The retry timer is unref'd, so keep the loop alive while somebody is
        // waiting. Unload uses close(), which never does this.
        if (keepAlive === null) keepAlive = setInterval(() => undefined, 250);
        idle.push(() => resolve());
        schedule();
      });
    },
  };
}
