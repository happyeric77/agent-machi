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
  /** True while a pass is retiring, so a second request does not stack. */
  private passRunning = false;
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

  /** Read one session, through the setup loaded for a directory when known. */
  private async readSession(sessionID: string, directory: string | null): Promise<Read> {
    const owner = this.registrationFor(directory) ?? this.setups[0];
    if (!owner) return { kind: "unknown" };
    let info: any;
    try {
      info = await within(Promise.resolve(owner.ctx?.session?.get?.({ sessionID })));
    } catch (error) {
      // A specific not-found is authoritative; a failure or a stall is not.
      return isMissing(error) ? { kind: "absent" } : { kind: "unknown" };
    }
    if (info === TIMEOUT) return { kind: "unknown" };
    const row = info?.data ?? info;
    if (!row?.id) return { kind: "unknown" };
    // Archiving leaves the row readable; it is not a resident either way.
    return isArchived(row) ? { kind: "absent" } : { kind: "row", row };
  }

  /**
   * Apply one session's current truth. An authoritative absence removes the
   * resident; a row admits it, or corrects it if it changed.
   */
  private applyRead(sessionID: string, read: Read, permissions?: readonly string[] | null): void {
    if (read.kind === "unknown") return;
    if (read.kind === "absent") {
      this.directories.delete(sessionID);
      this.dispatch({ kind: "reconcile", sessionID, view: null, missing: true });
      return;
    }
    this.directories.set(sessionID, read.row.location?.directory ?? null);
    this.dispatch({
      kind: "reconcile",
      sessionID,
      view: this.viewOf(read.row),
      permissions,
    });
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

  /** Page the whole session list: the API returns 50 newest by default. */
  private async listRows(owner: Registration): Promise<SessionRow[] | null> {
    const rows: SessionRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SEED_MAX_PAGES; page += 1) {
      let listed: any;
      try {
        listed = await within(
          Promise.resolve(owner.ctx?.session?.list?.({ limit: SEED_PAGE, ...(cursor ? { cursor } : {}) })),
        );
      } catch {
        return null;
      }
      if (listed === TIMEOUT) return null;
      const batch = listed?.data ?? listed;
      if (!Array.isArray(batch)) return null;
      rows.push(...batch);
      cursor = typeof listed?.cursor?.next === "string" ? listed.cursor.next : null;
      if (cursor === null || batch.length === 0) return rows;
    }
    return rows;
  }

  /**
   * Seed sessions executing at load. Returns false when the read failed, which
   * is what schedules a retry: a session that starts during an outage would
   * otherwise never be found.
   */
  private async seed(): Promise<boolean> {
    const owner = this.setups[0];
    if (!owner) return false;
    const rows = await this.listRows(owner);
    if (rows === null) return false;
    const views: SessionView[] = [];
    for (const row of rows) {
      if (!row.id || row.parentID || isArchived(row)) continue;
      if (!isExecuting(row, this.bootSince)) continue;
      // A known resident is corrected by its own checks. The list only carries
      // a name for one that arrived through an event, so a fresh title is not
      // thrown away while its next `get` is unavailable.
      if (this.state.sessions.has(row.id)) {
        const view = this.viewOf(row);
        this.dispatch({ kind: "renamed", sessionID: view.id, title: view.title ?? null });
        continue;
      }
      // A removed resident is not in the map at all, so this readmits it: the
      // list row is a fresh, non-archived observation of a live session.
      views.push(this.viewOf(row));
    }
    if (views.length > 0) this.dispatch({ kind: "discovered", sessions: views });
    return true;
  }

  /** One session's ground truth: execution, name, pending prompts. */
  private async check(sessionID: string): Promise<void> {
    const read = await this.readSession(sessionID, this.directories.get(sessionID) ?? null);
    if (read.kind !== "row") {
      this.applyRead(sessionID, read);
      return;
    }
    // Prompt reads are location-scoped: only the setup for this session's own
    // directory can describe its prompts. Without one it stays event-only.
    let permissions: readonly string[] | null | undefined;
    const location = this.registrationFor(read.row.location?.directory ?? null);
    if (location) permissions = await this.readPermissions(location, sessionID);
    this.applyRead(sessionID, read, permissions);
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
    return rows.map((row: any) => String(row?.id ?? "")).filter((id) => id !== "");
  }

  /**
   * A whole pass: seed until it lands, then check every live resident.
   *
   * It is queued like any other work, so it cannot interleave with an event's
   * read — that is what makes the last applied observation the true one.
   */
  private runPass(seedNow: boolean): void {
    // A pass is a chain of one-session steps, each queued separately. That is
    // what keeps a throttled pass from starving events: a delete or a prompt
    // reply arriving mid-pass is queued ahead of the remaining steps instead of
    // waiting behind the whole sweep.
    void seedNow;
    if (this.passRunning) {
      // A pass is already retiring; it will pick the seed need up.
      return;
    }
    const pass = ++this.passToken;
    let steps: string[] | null = null;
    const step = (): void => {
      this.enqueue(async () => {
        if (this.closed || pass !== this.passToken) return;
        if (steps === null) {
          // Every pass lists. Discovery cannot depend on an event arriving: a
          // session that starts during an outage, or one that comes back after
          // being removed, would otherwise never be seen again. One list call
          // per pass is cheap, and the pages are bounded.
          const ok = await this.seed();
          if (!this.alive(pass)) return;
          if (ok) this.clearSeedRetry();
          else this.scheduleSeedRetry();
          // Snapshot after seeding: a resident removed by it is already gone,
          // and one admitted by it belongs in this pass.
          steps = liveSessions(this.state);
        }
        const sessionID = steps.shift();
        if (sessionID !== undefined && this.state.sessions.has(sessionID)) {
          await this.check(sessionID);
          if (!this.alive(pass)) return;
        }
        if (steps.length > 0) {
          step();
          return;
        }
        this.passRunning = false;
      });
    };
    this.passRunning = true;
    step();
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
      this.runPass(true);
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
          this.runPass(true);
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
      this.runPass(false);
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
