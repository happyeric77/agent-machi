/**
 * Delivery layer: turns reducer actions into `/report` calls without ever
 * blocking the OpenCode event hook.
 *
 * The queue holds at most one desired write per resident: the latest state
 * always wins, whatever came before it, because the reducer only emits a post
 * for a resident it still tracks. A write already in flight is never replaced;
 * the newer state is sent after it. Bridge failures back off and never throw
 * into the hook that produced them.
 *
 * Pacing is per report endpoint, not per reporter: two machine ids aimed at the
 * same bridge share one lane, one request on the wire and one outage window, so
 * a bridge that is down is not hammered twice as hard because a second slug was
 * configured. Lanes live on `globalThis` so a plugin reload keeps them.
 */

export interface DeliveryConfig {
  readonly bridgeUrl: URL;
  readonly token: string;
  readonly source: string;
  readonly agent: string;
  readonly machineId: string;
  /** Bound for a single request, including a fetch that never settles. */
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

/** The canonical report endpoint: the lane key and the request target. */
export function reportURL(bridgeUrl: URL): URL {
  const url = new URL(bridgeUrl);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/(\/report)?$/, "/report");
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

interface Lane {
  /** The next write for each resident id; at most one each. */
  readonly queue: Map<string, Pending>;
  /** Requests on the wire, keyed by resident, so one is never sent twice. */
  readonly inflight: Map<string, AbortController>;
  outageUntil: number;
  /** Consecutive failed requests on this endpoint; reset by any success. */
  transportFailures: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the armed timer fires; 0 when none is armed. */
  timerDue: number;
  keepAlive: ReturnType<typeof setInterval> | null;
  idle: Array<() => void>;
  /** Live deliveries using this lane. */
  refs: number;
}

const LANES = Symbol.for("agent-machi.delivery.lanes");

function lanes(): Map<string, Lane> {
  const host = globalThis as unknown as Record<symbol, Map<string, Lane> | undefined>;
  return (host[LANES] ??= new Map());
}

function laneFor(url: string): Lane {
  const all = lanes();
  let lane = all.get(url);
  if (!lane) {
    lane = {
      queue: new Map(),
      inflight: new Map(),
      outageUntil: 0,
      transportFailures: 0,
      timer: null,
      timerDue: 0,
      keepAlive: null,
      idle: [],
      refs: 0,
    };
    all.set(url, lane);
  }
  return lane;
}

export function createDelivery(cfg: DeliveryConfig): Delivery {
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const target = reportURL(cfg.bridgeUrl);
  const lane = laneFor(target.toString());
  lane.refs += 1;
  let stopped = false;

  function settleIfIdle(): void {
    if (lane.queue.size > 0 || lane.inflight.size > 0) return;
    // Nothing is outstanding: a drain() waiter has nothing left to wait for, so
    // the keep-alive interval must not outlive it.
    if (lane.keepAlive !== null) {
      clearInterval(lane.keepAlive);
      lane.keepAlive = null;
    }
    const waiters = lane.idle;
    lane.idle = [];
    for (const resolve of waiters) resolve();
  }

  /** The resident this write is about; the queue key. */
  function keyOf(write: Write): string | null {
    return residentID(cfg.machineId, write.sessionID);
  }

  function enqueue(write: Write): void {
    if (stopped) return;
    const key = keyOf(write);
    // An id the bridge would reject is never sent: no truncating, no patching.
    if (key === null) {
      console.warn("[agent-machi] skipping a resident whose id breaks the bridge's limits");
      return;
    }
    const existing = lane.queue.get(key);
    // Same operation and same state keeps waiting out the backoff already
    // earned. Different work (a DELETE after a failing POST) gets a fresh
    // attempt budget, though it may not jump a retry already scheduled.
    const same = existing !== undefined && sameWrite(existing.write, write);
    lane.queue.set(key, {
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
    // An existing timer may be waiting out a long backoff while another write
    // is already due: re-arm instead of letting it wait.
    if (lane.timer !== null) {
      if (lane.timerDue <= next) return;
      clearTimeout(lane.timer);
      lane.timer = null;
    }
    lane.timerDue = next;
    lane.timer = setTimeout(() => {
      lane.timer = null;
      void pump();
    }, Math.max(0, next - Date.now()));
    // A pending retry must never hold the process open on its own.
    (lane.timer as unknown as { unref?: () => void }).unref?.();
  }

  function nextDue(): number | null {
    let due: number | null = null;
    for (const [key, pending] of lane.queue) {
      // An in-flight resident cannot be sent again yet; counting its deadline
      // would spin the timer.
      if (lane.inflight.has(key)) continue;
      if (due === null || pending.notBefore < due) due = pending.notBefore;
    }
    if (due === null) return null;
    // A fresh write must not slip inside the outage window: the bridge is down
    // for every resident on this endpoint.
    return Math.max(due, lane.outageUntil);
  }

  /**
   * Send one write at a time.
   *
   * One request on the wire per endpoint is what makes the outage window
   * actually apply: a burst of writes for several residents would otherwise all
   * leave before the first failure could open it.
   */
  async function pump(): Promise<void> {
    if (stopped || lane.inflight.size > 0) return;
    if (lane.outageUntil > Date.now()) {
      schedule();
      return;
    }
    const now = Date.now();
    let next: [string, Pending] | null = null;
    for (const entry of lane.queue) {
      if (entry[1].notBefore > now) continue;
      next = entry;
      break;
    }
    if (next === null) {
      settleIfIdle();
      return;
    }
    const [key, pending] = next;
    lane.queue.delete(key);
    const abort = new AbortController();
    lane.inflight.set(key, abort);
    void send(key, pending, abort).finally(() => {
      if (lane.inflight.get(key) === abort) lane.inflight.delete(key);
      schedule();
      settleIfIdle();
    });
    schedule();
  }

  async function send(key: string, pending: Pending, controller: AbortController): Promise<void> {
    const write = pending.write;
    // A fetch that observes the abort is the normal case, but one that never
    // settles must not hold the lane forever: the deadline releases it either
    // way, and a late settlement is ignored because this write is gone.
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<null>((resolve) => {
      deadline = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
      (deadline as unknown as { unref?: () => void }).unref?.();
    });
    let response: Response | null;
    try {
      response = await Promise.race([
        doFetch(requestURL(write), {
          method: write.type === "post" ? "POST" : "DELETE",
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            ...(write.type === "post" ? { "Content-Type": "application/json" } : {}),
          },
          ...(write.type === "post" ? { body: JSON.stringify(body(write)) } : {}),
          redirect: "manual",
          signal: controller.signal,
        }) as Promise<Response | null>,
        late,
      ]);
    } catch {
      response = null;
    } finally {
      if (deadline !== null) clearTimeout(deadline);
    }
    // A stall, a network failure or an abort is a transport failure, and it is
    // paced like one; a bridge that answers is a working endpoint.
    if (response === null) {
      retryOrDrop(key, write, pending);
      return;
    }
    if (response.ok) {
      lane.transportFailures = 0;
      lane.outageUntil = 0;
      return;
    }
    // A rejected write (bad id, wrong token, ingest off) will not be fixed by
    // retrying, but a transient 5xx might be.
    if (response.status >= 500) retryOrDrop(key, write, pending);
  }

  function retryOrDrop(key: string, write: Write, pending: Pending): void {
    // Unload already dropped the queue and cancelled this request.
    if (stopped) return;
    const attempts = pending.attempts + 1;
    const exhausted = attempts > MAX_ATTEMPTS;
    // Pacing advances on every transport failure, including the one that
    // exhausts a write: otherwise the endpoint reopens the instant a budget
    // runs out and the next resident hammers a bridge that is still down.
    lane.transportFailures += 1;
    const backoff = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (lane.transportFailures - 1));
    const notBefore = Date.now() + backoff;
    lane.outageUntil = Math.max(lane.outageUntil, notBefore);
    if (exhausted) {
      // This write is out of budget. An identical queued copy is the same work
      // and goes with it; different work keeps its own fresh budget.
      const queued = lane.queue.get(key);
      if (queued && sameWrite(queued.write, write)) lane.queue.delete(key);
      schedule();
      return;
    }
    const queued = lane.queue.get(key);
    if (queued) {
      // A newer state arrived while this one was failing. It runs into the same
      // outage, so it inherits the wait — but different work keeps its own
      // attempt budget rather than burning what the failed write already spent.
      queued.attempts = sameWrite(queued.write, write) ? Math.max(queued.attempts, attempts) : 0;
      queued.notBefore = Math.max(queued.notBefore, notBefore);
    } else {
      lane.queue.set(key, { write, attempts, notBefore });
    }
    schedule();
  }

  function requestURL(write: Write): string {
    const url = new URL(target);
    if (write.type === "delete") {
      url.searchParams.set("source", cfg.source);
      url.searchParams.set("id", keyOf(write) ?? "");
    }
    return url.toString();
  }

  function body(write: Extract<Write, { type: "post" }>): Record<string, string> {
    const payload: Record<string, string> = {
      source: cfg.source,
      id: keyOf(write) ?? "",
      status: write.status,
      agent: cfg.agent,
    };
    if (write.name) payload.name = write.name;
    return payload;
  }

  return {
    enqueue,
    close(): void {
      if (stopped) return;
      stopped = true;
      // Only this reporter's residents are dropped; another reporter sharing
      // the lane keeps its own queue and its own in-flight request.
      for (const key of [...lane.queue.keys()]) {
        if (key.startsWith(`${cfg.machineId}-`)) lane.queue.delete(key);
      }
      for (const [key, abort] of [...lane.inflight]) {
        if (!key.startsWith(`${cfg.machineId}-`)) continue;
        // A late POST could otherwise land after the replacement reporter has
        // already reported the same resident.
        abort.abort();
        lane.inflight.delete(key);
      }
      lane.refs -= 1;
      if (lane.refs <= 0) {
        if (lane.timer !== null) clearTimeout(lane.timer);
        lane.timer = null;
        lane.timerDue = 0;
        lane.queue.clear();
        for (const abort of lane.inflight.values()) abort.abort();
        lane.inflight.clear();
        lanes().delete(target.toString());
      }
      settleIfIdle();
    },
    drain(): Promise<void> {
      return new Promise((resolve) => {
        // Nothing will ever be sent again: a waiter would wait forever, and the
        // keep-alive interval would outlive the writer.
        if (stopped || (lane.queue.size === 0 && lane.inflight.size === 0)) {
          resolve();
          return;
        }
        // The retry timer is unref'd, so keep the loop alive explicitly while
        // somebody is waiting. Unload uses close(), which never does this.
        lane.keepAlive ??= setInterval(() => undefined, 250);
        lane.idle.push(resolve);
        schedule();
      });
    },
  };
}
