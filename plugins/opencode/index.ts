/**
 * Agent Machi reporter for OpenCode (V2 native plugin shape).
 *
 * Normalized events go into the pure reducer in reducer.ts; the actions it
 * emits are queued in delivery.ts, which talks to the bridge off the hook
 * path. This file is only the wiring: read options, subscribe, reconcile.
 *
 * All context reads run through one serial queue. Reads are the only place a
 * stale answer could commit — a metadata lookup racing a delete, a seed racing
 * a rename — and the queue makes that impossible rather than guarded: work
 * applied in arrival order means the last thing observed is always the thing
 * applied last. Renewals do not go through the queue; they are on their own
 * clock so a slow read can never let a lease lapse.
 */
import { createDelivery, reportURL, type Delivery, type Write } from "./delivery.ts";
import {
  createState,
  liveSessions,
  reduce,
  type Action,
  type Input,
  type SessionView,
} from "./reducer.ts";

const HEARTBEAT_MS = 5 * 60 * 1000;
const RECONNECT_MS = 2_000;
/** Bound for one context read, so a stalled call cannot hold the queue. */
const READ_TIMEOUT_MS = 5_000;
/** Sessions per listing page while seeding; the API returns 50 by default. */
const SEED_PAGE = 200;
/** Hard stop for bootstrap paging, so a huge history cannot delay seeding. */
const SEED_MAX_PAGES = 25;
/** Retry interval for a bootstrap list read that failed. */
const SEED_RETRY_MS = 5_000;

export interface ReporterOptions {
  readonly bridgeUrl?: unknown;
  readonly machineId?: unknown;
}

interface SessionRow {
  id?: string;
  parentID?: string | null;
  title?: string | null;
  location?: { directory?: string | null } | null;
  time?: { busy?: number; idle?: number; archived?: number } | null;
}

/** The plugin runs inside the OpenCode server, which has a process env. */
function serverEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

interface Config {
  readonly bridgeUrl: URL;
  readonly machineId: string;
  readonly token: string;
  readonly source: string;
  readonly agent: string;
}

function parseOptions(options: unknown, token: string | undefined): Config | null {
  if (!token) return null;
  const raw = (options ?? {}) as ReporterOptions;
  if (typeof raw.bridgeUrl !== "string" || typeof raw.machineId !== "string") return null;
  let bridgeUrl: URL;
  try {
    bridgeUrl = new URL(raw.bridgeUrl);
  } catch {
    return null;
  }
  if (bridgeUrl.protocol !== "http:" && bridgeUrl.protocol !== "https:") return null;
  // The bearer token travels in a header; never send it in the clear off-box.
  if (bridgeUrl.protocol !== "https:" && !isLoopback(bridgeUrl)) return null;
  // An id the bridge cannot accept is a configuration error, not a session
  // error: reject it before anything is tracked or logged.
  if (!/^[!-~]+$/.test(raw.machineId) || raw.machineId.includes(":")) return null;
  if (new TextEncoder().encode(raw.machineId).length > 100) return null;
  return { bridgeUrl, machineId: raw.machineId, token, source: "opencode", agent: "opencode" };
}

/**
 * A session is executing while its busy stamp is newer than its idle stamp and
 * it started inside this server process. `time.idle` is absent until the first
 * turn completes, so a session in its first-ever turn counts as executing.
 * The process guard matters after a crash: a server killed mid-run leaves
 * busy > idle forever, and without it bootstrap would resurrect that session.
 */
function isExecuting(row: SessionRow, since: number): boolean {
  const busy = row.time?.busy;
  if (typeof busy !== "number" || busy < since) return false;
  const idle = row.time?.idle;
  return typeof idle !== "number" || busy > idle;
}

/** Archived sessions still answer reads; the only trace is a `time` stamp. */
function isArchived(row: SessionRow): boolean {
  return typeof row.time?.archived === "number";
}

/** Returned when a read takes longer than its deadline. */
const TIMEOUT = Symbol("timeout");

async function within<T>(work: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function isMissing(error: unknown): boolean {
  return (error as { _tag?: unknown })?._tag === "Session.NotFoundError";
}

/** How long this server process has been up, in milliseconds. */
function uptimeMs(): number {
  const proc = (globalThis as { process?: { uptime?: () => number } }).process;
  const seconds = typeof proc?.uptime === "function" ? proc.uptime() : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/** A read's outcome: a row, an authoritative absence, or "no answer". */
type Read = { kind: "row"; row: SessionRow } | { kind: "absent" } | { kind: "unknown" };

/** A live plugin setup: the context it was handed, and where that lives. */
interface Registration {
  readonly directory: string | null;
  readonly ctx: any;
}

/**
 * One reporter per report endpoint, shared by every live setup.
 *
 * The event stream spans every location while plugin setup runs once per
 * location, so a reporter cannot belong to a setup: opening another location,
 * or unloading one, may not discard another location's residents, and a
 * surviving setup has to keep renewing them. Setups register their context
 * here; state and delivery belong to the reporter.
 *
 * The registry lives on `globalThis` because a config reload may re-evaluate
 * this module, which would otherwise forget a reporter that is still running.
 */
class Reporter {
  private readonly config: Config;
  private readonly state = createState();
  private readonly delivery: Delivery;
  private readonly setups: Registration[] = [];
  /** Where each known session lives; the reducer only holds resident state. */
  private readonly directories = new Map<string, string | null>();
  private readonly bootSince = Date.now() - uptimeMs();
  /** Work applied in arrival order: the whole point of this class. */
  private readonly queue: Array<() => Promise<unknown>> = [];
  private draining = false;
  private stream: { controller: AbortController; owner: Registration } | null = null;
  private streamOwner: Registration | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** True while a pass is running, so a second request does not stack. */
  private passRunning = false;
  /** A pass was requested during the current one: exactly one follows. */
  private passWanted = false;
  /** Bumped to retire a pass whose work is now obsolete. */
  private passToken = 0;
  private seedRetry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(config: Config) {
    this.config = config;
    this.delivery = createDelivery(config);
  }

  get live(): boolean {
    return !this.closed;
  }

  register(registration: Registration): void {
    this.setups.push(registration);
    this.startStream();
    this.startHeartbeat();
  }

  /**
   * Drop one setup. Its state is untouched: another location may still be
   * reporting into it, and only the last unload may shut the reporter down.
   */
  unregister(registration: Registration): void {
    const index = this.setups.indexOf(registration);
    if (index < 0) return; // already unregistered: cleanup is idempotent
    this.setups.splice(index, 1);
    if (this.setups.length === 0) {
      this.stop();
      return;
    }
    if (this.streamOwner === registration) {
      // The owner is gone but others remain: re-elect against a survivor
      // instead of reporting nothing.
      this.stream?.controller.abort();
      this.stream = null;
      this.streamOwner = null;
      this.startStream();
    }
  }

  /** Shut down from outside (tests); the same path an unload takes. */
  stop(): void {
    this.setups.length = 0;
    this.closed = true;
    this.stream?.controller.abort();
    this.stream = null;
    this.streamOwner = null;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.seedRetry !== null) clearTimeout(this.seedRetry);
    this.seedRetry = null;
    this.delivery.close();
    this.queue.length = 0;
    this.directories.clear();
    this.passWanted = false;
    this.passRunning = false;
  }

  private send(action: Action): void {
    const write: Write =
      action.type === "delete"
        ? { type: "delete", sessionID: action.sessionID }
        : { type: "post", sessionID: action.sessionID, status: action.status, name: action.name };
    this.delivery.enqueue(write);
  }

  private dispatch(input: Input): void {
    if (this.closed) return;
    try {
      for (const action of reduce(this.state, input)) this.send(action);
    } catch {
      // A reducer fault must never surface in the host's event loop.
    }
  }

  /**
   * Append work and drain the queue. Tasks run strictly one at a time, so no
   * two reads can be in flight for the same state.
   */
  private enqueue(task: () => Promise<unknown>): void {
    if (this.closed) return;
    this.queue.push(task);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const task = this.queue.shift();
        if (!task || this.closed) return;
        try {
          await task();
        } catch {
          // One failed task must not stop the queue.
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** The context loaded for a directory, for location-scoped reads. */
  /** A context that unloaded while a call was in flight. */
  private retired(owner: Registration): boolean {
    return this.closed || !this.setups.includes(owner);
  }

  private registrationFor(directory: string | null): Registration | null {
    if (directory === null) return null;
    return this.setups.find((setup) => setup.directory === directory) ?? null;
  }

  private viewOf(row: SessionRow): SessionView {
    return {
      id: String(row.id),
      parentID: row.parentID ?? null,
      title: row.title ?? null,
      directory: row.location?.directory ?? null,
      executing: isExecuting(row, this.bootSince),
    };
  }

  /**
   * Read one session, through the setup loaded for a directory when known.
   *
   * The owner is re-checked after the await on both paths: a context that
   * unloaded while its call was outstanding must not publish a row, and even
   * its not-found is not authoritative, because the reporter may already be
   * running on a survivor that knows better.
   */
  private async readSession(sessionID: string, directory: string | null): Promise<Read> {
    const owner = this.registrationFor(directory) ?? this.setups[0];
    if (!owner) return { kind: "unknown" };
    let info: any;
    try {
      info = await within(Promise.resolve(owner.ctx?.session?.get?.({ sessionID })));
    } catch (error) {
      // A specific not-found is authoritative; a failure or a stall is not.
      if (this.retired(owner)) return { kind: "unknown" };
      return isMissing(error) ? { kind: "absent" } : { kind: "unknown" };
    }
    if (info === TIMEOUT || this.retired(owner)) return { kind: "unknown" };
    const row = info?.data ?? info;
    if (!row?.id) return { kind: "unknown" };
    // Archiving leaves the row readable; it is not a resident either way.
    return isArchived(row) ? { kind: "absent" } : { kind: "row", row };
  }

  /**
   * Apply one session's current truth. An authoritative absence removes the
   * resident; a row admits it, or corrects it if it changed.
   */
  private applyRead(
    sessionID: string,
    read: Read,
    permissions?: readonly string[] | null,
    owner?: Registration,
  ): void {
    if (read.kind === "unknown") return;
    // A read that outlived the context that issued it is discarded: the
    // survivor owns this state now and its next pass re-reads it.
    if (owner && this.retired(owner)) return;
    if (read.kind === "absent") {
      this.directories.delete(sessionID);
      this.dispatch({ kind: "reconcile", sessionID, view: null, missing: true });
      return;
    }
    const view = this.viewOf(read.row);
    // A child is never a resident, so it never gets a directory entry either:
    // that entry is what routes its later prompt reads.
    if (view.parentID) return;
    this.directories.set(sessionID, view.directory ?? null);
    this.dispatch({ kind: "reconcile", sessionID, view, permissions });
  }

  /**
   * Admit a session a lifecycle event mentions but this reporter has not seen.
   *
   * Only lifecycle events may do this. A prompt event applied to an admitted
   * session would let a stale form bring a removed resident back already
   * blocked, and a prompt read on the next pass recovers that case anyway.
   * An archived or absent row is never admitted, because `readSession` reports
   * it as absent rather than as a row.
   */
  private async admit(sessionID: string): Promise<void> {
    if (this.state.sessions.has(sessionID)) return;
    const read = await this.readSession(sessionID, this.directories.get(sessionID) ?? null);
    if (read.kind === "unknown") return;
    // An absent row is not a resident, so nothing is admitted and nothing is
    // deleted on behalf of an event: only a pass removes a resident, and only
    // after a read proved it gone.
    if (read.kind === "absent") return;
    this.applyRead(sessionID, read);
  }

  /**
   * One page of the session list. Paging is a pass step of its own, so a
   * throttled page cannot hold events behind the rest of the list.
   */
  private async listPage(
    owner: Registration,
    cursor: string | null,
  ): Promise<{ rows: SessionRow[]; next: string | null } | null> {
    if (this.retired(owner)) return null;
    let listed: any;
    try {
      listed = await within(
        Promise.resolve(owner.ctx?.session?.list?.({ limit: SEED_PAGE, ...(cursor ? { cursor } : {}) })),
      );
    } catch {
      return null;
    }
    if (listed === TIMEOUT || this.retired(owner)) return null;
    const batch = listed?.data ?? listed;
    if (!Array.isArray(batch)) return null;
    // A malformed row is skipped, never thrown on: one bad row must not wedge
    // discovery for every other session.
    const rows = batch.filter(
      (row: any): row is SessionRow => row !== null && typeof row === "object" && typeof row.id === "string",
    );
    const next = typeof listed?.cursor?.next === "string" ? listed.cursor.next : null;
    return { rows, next };
  }

  /**
   * Seed sessions executing at load. Returns false when the read failed, which
   * is what schedules a retry: a session that starts during an outage would
   * otherwise never be found.
   */
  /**
   * Apply one page of the session list. Returns nothing: a page either lands
   * or it does not, and the pass decides whether to continue.
   */
  private applyListRows(rows: readonly SessionRow[]): void {
    const views: SessionView[] = [];
    for (const row of rows) {
      if (!row.id || row.parentID || isArchived(row)) continue;
      const view = this.viewOf(row);
      // A live resident's fresh title is taken before the executing filter: the
      // list is the only metadata source when its `get` is failing, and a title
      // is not a status change.
      if (this.state.sessions.has(view.id)) {
        this.dispatch({ kind: "renamed", sessionID: view.id, title: view.title ?? null });
        continue;
      }
      if (!isExecuting(row, this.bootSince)) continue;
      // A removed resident is not in the map at all, so this readmits it: the
      // list row is a fresh, non-archived observation of a live session.
      views.push(view);
    }
    if (views.length > 0) this.dispatch({ kind: "discovered", sessions: views });
  }

  /** One session's ground truth: execution, name, pending prompts. */
  private async check(sessionID: string): Promise<void> {
    const directory = this.directories.get(sessionID) ?? null;
    const owner = this.registrationFor(directory) ?? this.setups[0];
    const read = await this.readSession(sessionID, directory);
    if (read.kind !== "row") {
      this.applyRead(sessionID, read, undefined, owner);
      return;
    }
    // Prompt reads are location-scoped: only the setup for this session's own
    // directory can describe its prompts. Without one it stays event-only.
    let permissions: readonly string[] | null | undefined;
    const location = this.registrationFor(read.row.location?.directory ?? null);
    if (location) permissions = await this.readPermissions(location, sessionID);
    this.applyRead(sessionID, read, permissions, owner);
  }

  private async readPermissions(
    owner: Registration,
    sessionID: string,
  ): Promise<readonly string[] | null> {
    let pending: any;
    try {
      pending = await within(Promise.resolve(owner.ctx?.permission?.list?.({ sessionID })));
    } catch {
      return null;
    }
    // Only an actual list is authoritative. A stall, a missing method or an
    // unexpected payload is an unknown answer, not "nothing pending".
    if (pending === TIMEOUT || pending === null || this.retired(owner)) return null;
    const rows = Array.isArray(pending) ? pending : pending?.data;
    if (!Array.isArray(rows)) return null;
    // A record without an id means this payload is not what it claims to be.
    // Treating it as an empty list would clear a real block.
    const ids: string[] = [];
    for (const row of rows as any[]) {
      if (typeof row?.id !== "string" || row.id === "") return null;
      ids.push(row.id);
    }
    return ids;
  }

  /**
   * A pass is a chain of small queued steps — one list page, then one session
   * check — so an event arriving mid-pass is queued ahead of the remaining
   * steps instead of waiting behind the whole sweep.
   *
   * A pass requested while one is running is coalesced into exactly one more
   * pass afterwards. That is what makes a reconnect during a slow sweep still
   * re-seed, without letting a flapping stream stack passes.
   */
  private runPass(): void {
    if (this.closed) return;
    if (this.passRunning) {
      this.passWanted = true;
      return;
    }
    this.passRunning = true;
    this.passWanted = false;
    this.queueSeedPage(++this.passToken, null, 0);
  }

  private finishPass(pass: number): void {
    if (pass !== this.passToken) return;
    this.passRunning = false;
    if (this.passWanted && !this.closed) {
      this.passWanted = false;
      this.runPass();
    }
  }

  /** One list page, then either the next page or the first session check. */
  private queueSeedPage(pass: number, cursor: string | null, page: number): void {
    this.enqueue(async () => {
      if (!this.alive(pass)) return this.finishPass(pass);
      const owner = this.setups[0];
      if (!owner) return this.finishPass(pass);
      const listed = await this.listPage(owner, cursor);
      if (!this.alive(pass)) return this.finishPass(pass);
      if (listed === null) {
        this.scheduleSeedRetry();
        return this.finishPass(pass);
      }
      this.clearSeedRetry();
      this.applyListRows(listed.rows);
      if (listed.next !== null && page + 1 < SEED_MAX_PAGES) {
        return this.queueSeedPage(pass, listed.next, page + 1);
      }
      this.queueCheck(pass, liveSessions(this.state), 0);
    });
  }

  /** One session's check, then the next, so events interleave with the sweep. */
  private queueCheck(pass: number, ids: readonly string[], index: number): void {
    this.enqueue(async () => {
      if (!this.alive(pass)) return this.finishPass(pass);
      const sessionID = ids[index];
      // The pass snapshot may name a resident an interim event removed.
      if (sessionID !== undefined && this.state.sessions.has(sessionID)) await this.check(sessionID);
      if (!this.alive(pass)) return this.finishPass(pass);
      if (index + 1 < ids.length) return this.queueCheck(pass, ids, index + 1);
      this.finishPass(pass);
    });
  }

  private alive(pass: number): boolean {
    return !this.closed && pass === this.passToken;
  }

  private scheduleSeedRetry(): void {
    // Retry is owed for the failed list read itself, so a disconnect whose seed
    // failed is still retried after a startup that succeeded.
    if (this.closed || this.seedRetry !== null) return;
    this.seedRetry = setTimeout(() => {
      this.seedRetry = null;
      this.runPass();
    }, SEED_RETRY_MS);
    (this.seedRetry as unknown as { unref?: () => void }).unref?.();
  }

  private clearSeedRetry(): void {
    if (this.seedRetry !== null) clearTimeout(this.seedRetry);
    this.seedRetry = null;
  }

  private onEvent(event: any): void {
    const data = event?.data;
    if (!data) return;
    switch (event?.type) {
      case "session.created":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.enqueue(() => this.admit(sessionID));
        }
        return;
      case "session.renamed":
        if (typeof data.sessionID === "string" && "title" in data) {
          const sessionID = data.sessionID;
          const title = typeof data.title === "string" ? data.title : null;
          // A rename carries the new name itself, but a session that was never
          // seen still has to be admitted before the reducer knows it.
          this.enqueue(async () => {
            await this.admit(sessionID);
            this.dispatch({ kind: "renamed", sessionID, title });
          });
        }
        return;
      case "session.execution.started":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.enqueue(async () => {
            await this.admit(sessionID);
            this.dispatch({ kind: "execution-started", sessionID });
          });
        }
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.enqueue(async () => {
            // A start that was never admitted must not swallow the end.
            await this.admit(sessionID);
            this.dispatch({ kind: "execution-ended", sessionID });
          });
        }
        return;
      case "permission.asked":
        if (typeof data.sessionID === "string" && typeof data.id === "string") {
          const sessionID = data.sessionID;
          const requestID = data.id;
          this.enqueue(async () => {
            // No admission: see admit()'s note. The next pass reads prompts.
            this.dispatch({ kind: "permission-asked", sessionID, requestID });
          });
        }
        return;
      case "permission.replied":
        if (typeof data.sessionID === "string" && typeof data.requestID === "string") {
          const sessionID = data.sessionID;
          const requestID = data.requestID;
          this.enqueue(async () => {
            this.dispatch({ kind: "permission-replied", sessionID, requestID });
          });
        }
        return;
      case "form.created": {
        const formID = data?.form?.id;
        const sessionID = data?.form?.sessionID;
        if (typeof sessionID === "string" && typeof formID === "string") {
          this.enqueue(async () => {
            this.dispatch({ kind: "form-created", sessionID, formID });
          });
        }
        return;
      }
      case "form.replied":
      case "form.cancelled":
        if (typeof data.sessionID === "string" && typeof data.id === "string") {
          const sessionID = data.sessionID;
          const formID = data.id;
          const kind = event.type === "form.replied" ? "form-replied" : "form-cancelled";
          this.enqueue(async () => {
            this.dispatch({ kind, sessionID, formID });
          });
        }
        return;
      case "session.deleted":
      case "session.archived":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          // Queued behind any pending admission, so a delete always outranks
          // the birth that admission was about to report.
          this.enqueue(async () => {
            // The directory entry is what routes later reads; a removed session
            // must not keep one.
            this.directories.delete(sessionID);
            this.dispatch({ kind: "deleted", sessionID });
          });
        }
        return;
      default:
        return;
    }
  }

  private startStream(): void {
    if (this.closed || this.stream || this.setups.length === 0) return;
    const owner = this.setups[0];
    if (!owner) return;
    const controller = new AbortController();
    this.stream = { controller, owner };
    this.streamOwner = owner;
    // An abort is cooperative: a generator may still yield one last event, and
    // a retired stream must not publish it.
    const live = (): boolean =>
      !this.closed && !controller.signal.aborted && this.streamOwner === owner;
    void (async () => {
      while (live()) {
        try {
          const events = owner.ctx?.event?.subscribe?.({ signal: controller.signal });
          // Start consuming before the pass. An async generator is pull-based:
          // while a read is pending nothing pulls it, so events are dropped.
          const reader = (async () => {
            for await (const event of events ?? []) {
              if (!live()) return;
              this.onEvent(event);
            }
          })();
          // Every reconnect re-seeds: a session can have started and finished
          // entirely while the stream was down.
          this.runPass();
          await reader;
        } catch {
          // Fall through to the backoff below.
        }
        if (!live()) return;
        await new Promise((resolve) => {
          const retry = setTimeout(resolve, RECONNECT_MS);
          (retry as unknown as { unref?: () => void }).unref?.();
        });
      }
    })().finally(() => {
      if (this.stream?.controller === controller) {
        this.stream = null;
        this.streamOwner = null;
      }
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.closed) return;
    let lastBeat = Date.now();
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      // Catch up immediately after a suspend/resume where it is overdue.
      if (Date.now() - lastBeat < HEARTBEAT_MS) return;
      lastBeat = Date.now();
      // Renewal is independent of reading: a stalled read must never let a
      // healthy resident's lease lapse.
      this.dispatch({ kind: "tick" });
      this.runPass();
    }, Math.min(60_000, HEARTBEAT_MS));
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();
  }
}

const REGISTRY = Symbol.for("agent-machi.reporter");

function reporters(): Map<string, Reporter> {
  const host = globalThis as unknown as Record<symbol, Map<string, Reporter> | undefined>;
  return (host[REGISTRY] ??= new Map());
}

/**
 * Keyed by where writes actually go, not by how the option was spelled: two
 * setups that land on the same report endpoint for the same resident namespace
 * must share one writer, or their requests are not serialised at all. The token
 * decides credentials, not destination, so it is not part of the key.
 */
function keyOf(config: Config): string {
  return [reportURL(config.bridgeUrl).toString(), config.machineId, config.source].join("\n");
}

/** Shut every live reporter down. Tests use this; nothing in the plugin does. */
export function stopAllReporters(): void {
  for (const reporter of reporters().values()) reporter.stop();
  reporters().clear();
}

export const AgentMachiReporter = {
  id: "agent-machi-reporter",
  async setup(ctx: any) {
    const config = parseOptions(ctx?.options, serverEnv("AGENT_MACHI_INGEST_TOKEN"));
    // Missing or invalid config disables reporting without touching the host.
    if (!config) return;

    const registry = reporters();
    const key = keyOf(config);
    let reporter = registry.get(key);
    if (!reporter || !reporter.live) {
      reporter = new Reporter(config);
      registry.set(key, reporter);
    }
    const owner = reporter;
    const registration: Registration = {
      directory: typeof ctx?.location?.directory === "string" ? ctx.location.directory : null,
      ctx,
    };
    owner.register(registration);

    return () => {
      owner.unregister(registration);
      // Remove the entry only if this reporter is the one still registered and
      // it is gone: a duplicate cleanup must not evict its replacement.
      if (!owner.live && registry.get(key) === owner) registry.delete(key);
    };
  },
};

export default AgentMachiReporter;
