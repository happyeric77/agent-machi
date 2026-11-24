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
 * configured. Because the lane is shared, the lane — not the reporter that
 * happened to arm it — owns the timer and the request: every queued write
 * carries the reporter (and therefore the token, source and machine id) it
 * belongs to. Lanes live on `globalThis` so a plugin reload keeps them.
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

/**
 * One reporter's delivery handle. Queued work keeps the owner rather than
 * relying on whoever pumps it, because the lane is shared by several owners.
 */
interface Owner {
  readonly timeoutMs: number;
  readonly doFetch: typeof globalThis.fetch;
  readonly source: string;
  readonly agent: string;
  readonly machineId: string;
  readonly target: URL;
  readonly token: string;
  stopped: boolean;
}

interface Pending {
  readonly owner: Owner;
  readonly write: Write;
  /** Attempts spent on this exact write; a different write starts at zero. */
  attempts: number;
  notBefore: number;
}

interface Inflight {
  readonly owner: Owner;
  readonly abort: AbortController;
}

interface Lane {
  /** The next write for each resident id; at most one each. */
  readonly queue: Map<string, Pending>;
  /** Requests on the wire, keyed by resident, so one is never sent twice. */
  readonly inflight: Map<string, Inflight>;
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
  pumping: boolean;
}

const LANES = Symbol.for("agent-machi.delivery.lanes");

function lanes(): Map<string, Lane> {
  const host = globalThis as unknown as Record<symbol, Map<string, Lane> | undefined>;
  return (host[LANES] ??= new Map());
}

export function createDelivery(cfg: DeliveryConfig): Delivery {
  const target = reportURL(cfg.bridgeUrl);
  const laneKey = target.toString();
  const lane = laneFor(laneKey);
  lane.refs += 1;
  const owner: Owner = {
    timeoutMs: cfg.timeoutMs ?? 5_000,
    doFetch: cfg.fetch ?? globalThis.fetch,
    source: cfg.source,
    agent: cfg.agent,
    machineId: cfg.machineId,
    target,
    token: cfg.token,
    stopped: false,
  };

  /**
   * The resident this write is about; the queue key. The source is part of it
   * because the bridge keys a resident by `source` + `id`: two sources sharing
   * an id are two residents, and coalescing them would drop one silently.
   */
  function keyOf(write: Write): string | null {
    const id = residentID(owner.machineId, write.sessionID);
    return id === null ? null : `${owner.source}\u0000${id}`;
  }

  function enqueue(write: Write): void {
    if (owner.stopped) return;
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
      owner,
      write,
      attempts: same ? existing.attempts : 0,
      notBefore: existing?.notBefore ?? 0,
    });
    schedule(lane);
  }

  return {
    enqueue,
    close(): void {
      if (owner.stopped) return;
      owner.stopped = true;
      // Only this owner's residents are dropped; another reporter sharing the
      // lane keeps its own queue and its own in-flight request. Ownership is by
      // object identity, never by id prefix: `mini` must not touch `mini-lab`.
      for (const [key, pending] of [...lane.queue]) {
        if (pending.owner === owner) lane.queue.delete(key);
      }
      for (const [key, request] of [...lane.inflight]) {
        if (request.owner !== owner) continue;
        // A late POST could otherwise land after the replacement reporter has
        // already reported the same resident.
        request.abort.abort();
        lane.inflight.delete(key);
      }
      lane.refs -= 1;
      if (lane.refs <= 0) retireLane(laneKey, lane);
      else {
        // A survivor may still have work: the lane owns the timer now, so
        // closing a reporter that happened to arm it must not strand anyone.
        settleIfIdle(lane);
        schedule(lane);
      }
      settleIfIdle(lane);
    },
    drain(): Promise<void> {
      return new Promise((resolve) => {
        // Nothing will ever be sent again: a waiter would wait forever, and the
        // keep-alive interval would outlive the writer.
        if (owner.stopped || (lane.queue.size === 0 && lane.inflight.size === 0)) {
          resolve();
          return;
        }
        // The retry timer is unref'd, so keep the loop alive explicitly while
        // somebody is waiting. Unload uses close(), which never does this.
        lane.keepAlive ??= setInterval(() => undefined, 250);
        lane.idle.push(resolve);
        schedule(lane);
      });
    },
  };
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
      pumping: false,
    };
    // A cooldown earned by the lane this one replaces still applies.
    const until = cooling().get(url);
    if (until !== undefined && until > Date.now()) lane.outageUntil = until;
    all.set(url, lane);
  }
  return lane;
}

function retireLane(url: string, lane: Lane): void {
  if (lane.timer !== null) clearTimeout(lane.timer);
  lane.timer = null;
  lane.timerDue = 0;
  if (lane.keepAlive !== null) clearInterval(lane.keepAlive);
  lane.keepAlive = null;
  lane.queue.clear();
  for (const request of lane.inflight.values()) request.abort.abort();
  lane.inflight.clear();
  const waiters = lane.idle;
  lane.idle = [];
  for (const resolve of waiters) resolve();
  // The destination has not changed and it was failing a moment ago, so the
  // cooldown outlives the reporter that learned it: a reload must not turn one
  // outage into a burst of requests. A cooldown that already expired is simply
  // not worth carrying.
  const now = Date.now();
  if (lane.outageUntil > now) {
    cooling().set(url, lane.outageUntil);
    pruneCooling(now);
  }
  lanes().delete(url);
}

/**
 * Endpoint cooldowns that outlived their lane. Bounded so a process that churns
 * through endpoints cannot accumulate entries forever.
 */
const COOLING = Symbol.for("agent-machi.delivery.cooldowns");
const MAX_COOLING = 64;

function cooling(): Map<string, number> {
  const host = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (host[COOLING] ??= new Map());
}

function pruneCooling(now: number): void {
  const all = cooling();
  for (const [url, until] of [...all]) {
    if (until <= now) all.delete(url);
  }
  // Map iteration follows insertion order, so the oldest entry goes first.
  while (all.size > MAX_COOLING) {
    const oldest = all.keys().next();
    if (oldest.done) break;
    all.delete(oldest.value);
  }
}

function settleIfIdle(lane: Lane): void {
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

function schedule(lane: Lane): void {
  const next = nextDue(lane);
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
    void pump(lane);
  }, Math.max(0, next - Date.now()));
  // A pending retry must never hold the process open on its own.
  (lane.timer as unknown as { unref?: () => void }).unref?.();
}

function nextDue(lane: Lane): number | null {
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
 * leave before the first failure could open it. The lane pumps, so a write
 * belonging to a reporter that has since unloaded is never sent — it was
 * removed from the queue by `close()` — while a survivor's write still is.
 */
async function pump(lane: Lane): Promise<void> {
  if (lane.pumping || lane.inflight.size > 0) return;
  if (lane.outageUntil > Date.now()) {
    schedule(lane);
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
    settleIfIdle(lane);
    return;
  }
  const [key, pending] = next;
  lane.queue.delete(key);
  const abort = new AbortController();
  lane.inflight.set(key, { owner: pending.owner, abort });
  lane.pumping = true;
  void send(lane, key, pending, abort)
    .finally(() => {
      lane.pumping = false;
      if (lane.inflight.get(key)?.abort === abort) lane.inflight.delete(key);
      schedule(lane);
      settleIfIdle(lane);
    });
  schedule(lane);
}

async function send(
  lane: Lane,
  key: string,
  pending: Pending,
  controller: AbortController,
): Promise<void> {
  const { owner, write } = pending;
  // A fetch that observes the abort is the normal case, but one that never
  // settles must not hold the lane forever: the deadline releases it either
  // way, and a late settlement is ignored because this write is gone.
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => {
    deadline = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, owner.timeoutMs);
    (deadline as unknown as { unref?: () => void }).unref?.();
    // A close() aborts the controller; the race must end there too, because a
    // fetch is free to ignore the signal. The deadline is the slow fallback.
    controller.signal.addEventListener(
      "abort",
      () => {
        if (deadline !== null) clearTimeout(deadline);
        resolve(null);
      },
      { once: true },
    );
  });
  let response: Response | null;
  try {
    response = await Promise.race([
      owner.doFetch(requestURL(owner, write), {
        method: write.type === "post" ? "POST" : "DELETE",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          ...(write.type === "post" ? { "Content-Type": "application/json" } : {}),
        },
        ...(write.type === "post" ? { body: JSON.stringify(body(owner, write)) } : {}),
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
  // Arriving after the owner unloaded still counts: the bridge may have taken
  // it, and dropping it silently would hide a write the reporter promised.
  if (response === null) {
    retryOrDrop(lane, owner, key, write, pending);
    return;
  }
  if (response.ok) {
    lane.transportFailures = 0;
    lane.outageUntil = 0;
    return;
  }
  // A rejected write (bad id, wrong token, ingest off) will not be fixed by
  // retrying, but a transient 5xx might be.
  if (response.status >= 500) retryOrDrop(lane, owner, key, write, pending);
}

function retryOrDrop(
  lane: Lane,
  owner: Owner,
  key: string,
  write: Write,
  pending: Pending,
): void {
  // Unload already dropped this owner's queue and cancelled its request.
  if (owner.stopped) return;
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
    schedule(lane);
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
    lane.queue.set(key, { owner, write, attempts, notBefore });
  }
  schedule(lane);
}

function requestURL(owner: Owner, write: Write): string {
  const url = new URL(owner.target);
  if (write.type === "delete") {
    url.searchParams.set("source", owner.source);
    url.searchParams.set("id", residentID(owner.machineId, write.sessionID) ?? "");
  }
  return url.toString();
}

function body(owner: Owner, write: Extract<Write, { type: "post" }>): Record<string, string> {
  const payload: Record<string, string> = {
    source: owner.source,
    id: residentID(owner.machineId, write.sessionID) ?? "",
    status: write.status,
    agent: owner.agent,
  };
  if (write.name) payload.name = write.name;
  return payload;
}
