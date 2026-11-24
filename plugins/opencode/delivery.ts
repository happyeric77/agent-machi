/**
 * Delivery layer: turns reducer actions into `/report` calls without ever
 * blocking the OpenCode event hook.
 *
 * The queue is per session and holds at most one pending write: a newer state
 * replaces an older one that has not been sent yet, and a delete cancels any
 * queued post for the same session. Bridge failures back off and never throw
 * into the hook that produced them.
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
  /** Drop everything and stop: used on unload, never holds the process open. */
  close(): void;
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

const MAX_BACKOFF_MS = 60_000;

interface Pending {
  write: Write;
  attempts: number;
  notBefore: number;
}

export function createDelivery(cfg: DeliveryConfig): Delivery {
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const queue = new Map<string, Pending>();
  const inflight = new Set<string>();
  let idle: Array<() => void> = [];
  let stopped = false;

  function settleIfIdle(): void {
    if (queue.size === 0 && inflight.size === 0) {
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
    const existing = queue.get(write.sessionID);
    if (write.type === "delete") {
      // A delete always supersedes a queued post for the same resident.
      queue.set(write.sessionID, { write, attempts: 0, notBefore: 0 });
    } else if (existing && existing.write.type === "delete" && !inflight.has(write.sessionID)) {
      // A resident already removed must not be recreated by a stale post;
      // only its own later events may do that, and those arrive as new writes
      // after the delete has been taken off the queue.
      return;
    } else {
      // Carrying the attempt count keeps a superseding state behind the same
      // backoff the failed attempt earned, instead of retrying immediately.
      queue.set(write.sessionID, { write, attempts: existing?.attempts ?? 0, notBefore: existing?.notBefore ?? 0 });
    }
    schedule();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (timer !== null || stopped) return;
    const next = nextDue();
    if (next === null) return;
    const delay = Math.max(0, next - Date.now());
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, delay);
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
    return due;
  }

  async function pump(): Promise<void> {
    if (stopped) return;
    const now = Date.now();
    for (const [sessionID, pending] of [...queue]) {
      if (pending.notBefore > now) continue;
      if (inflight.has(sessionID)) continue;
      queue.delete(sessionID);
      inflight.add(sessionID);
      void send(sessionID, pending).finally(() => {
        inflight.delete(sessionID);
        schedule();
        settleIfIdle();
      });
    }
    schedule();
    settleIfIdle();
  }

  async function send(sessionID: string, pending: Pending): Promise<void> {
    const write = pending.write;
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
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      retryOrDrop(write, pending);
      return;
    }
    if (response.ok) return;
    // A rejected write (bad id, wrong token, ingest off) will not be fixed by
    // retrying, but a transient 5xx or a stalled bridge might be.
    if (response.status >= 500) {
      retryOrDrop(write, pending);
      return;
    }
  }

  function retryOrDrop(write: Write, pending: Pending): void {
    const attempts = pending.attempts + 1;
    if (attempts > 8) return;
    const backoff = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (attempts - 1));
    const existing = queue.get(write.sessionID);
    // Latest state wins: only re-queue when nothing newer replaced it.
    if (existing && existing.write !== write) return;
    queue.set(write.sessionID, {
      write,
      attempts,
      notBefore: Date.now() + backoff,
    });
    schedule();
  }

  function requestURL(write: Write): string {
    const id = residentID(cfg.machineId, write.sessionID);
    const url = new URL(cfg.bridgeUrl);
    url.pathname = url.pathname.replace(/\/?$/, "/report");
    if (write.type === "post") return url.toString();
    url.searchParams.set("source", cfg.source);
    url.searchParams.set("id", id ?? "");
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
      queue.clear();
      const waiters = idle;
      idle = [];
      for (const resolve of waiters) resolve();
    },
    drain(): Promise<void> {
      return new Promise((resolve) => {
        if (queue.size === 0 && inflight.size === 0) {
          resolve();
          return;
        }
        // The retry timer is unref'd, so keep the loop alive explicitly while
        // somebody is waiting. Unload uses close(), which never does this.
        const keepAlive = setInterval(() => undefined, 250);
        idle.push(() => {
          clearInterval(keepAlive);
          resolve();
        });
        schedule();
      });
    },
  };
}
