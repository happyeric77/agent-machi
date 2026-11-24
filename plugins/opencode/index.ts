/**
 * Agent Machi reporter for OpenCode (V2 native plugin shape).
 *
 * Normalized events go into the pure reducer in reducer.ts; the actions it
 * emits are queued in delivery.ts, which talks to the bridge off the hook
 * path. This file is only the wiring: read options, subscribe, reconcile.
 */
import { createDelivery, type Delivery, type Write } from "./delivery.ts";
import {
  createState,
  liveSessions,
  reduce,
  type Action,
  type Input,
  type SessionView,
  type State,
} from "./reducer.ts";

const HEARTBEAT_MS = 5 * 60 * 1000;
const RECONNECT_MS = 2_000;
/** Bound for one metadata read, so a stall can never hold a session's chain. */
const READ_TIMEOUT_MS = 5_000;
/** Sessions per listing page while seeding; the API returns 50 by default. */
const SEED_PAGE = 200;
/** Hard stop for bootstrap paging, so a huge history cannot delay seeding. */
const SEED_MAX_PAGES = 25;

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

/** Returned when a read takes longer than the deadline. */
const TIMEOUT = Symbol("timeout");

/** Resolves to TIMEOUT on a stall; rejects exactly as the work rejects. */
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

/**
 * Reads a session's pending permission ids; a failed read is `null`.
 * Prompt reads are location-scoped, so the context must be the one loaded for
 * the session's own directory.
 */
async function readPermissions(ctx: any, sessionID: string): Promise<readonly string[] | null> {
  let pending: any;
  try {
    pending = await within(Promise.resolve(ctx?.permission?.list?.({ sessionID })));
  } catch {
    return null;
  }
  if (pending === TIMEOUT) return null; // a failed read is never an empty set
  const rows: any[] = Array.isArray(pending) ? pending : (pending?.data ?? []);
  return rows.map((row: any) => String(row?.id ?? "")).filter((id) => id !== "");
}

/** A live plugin setup: the context it was handed, and where that lives. */
interface Registration {
  readonly directory: string | null;
  readonly ctx: any;
}

/**
 * One reporter per bridge configuration, shared by every live setup.
 *
 * The event stream spans every location while plugin setup runs once per
 * location, so a reporter must outlive any single setup: opening another
 * location, or unloading one, may not discard the state of the others, and a
 * surviving setup has to keep renewing leases. Setups therefore register their
 * context here; state and delivery belong to the reporter, not to a setup.
 * The registry lives on `globalThis` because a config reload may re-evaluate
 * this module, which would otherwise forget a reporter that is still running.
 */
class Reporter {
  private readonly config: Config;
  private readonly state: State = createState();
  private readonly delivery: Delivery;
  private readonly versions = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  /** Sessions confirmed gone, including ones this reporter never tracked. */
  private readonly removed = new Set<string>();
  private readonly setups: Registration[] = [];
  private readonly bootSince = Date.now() - uptimeMs();
  private stream: { controller: AbortController; ctx: any } | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private again = false;
  private seeded = false;
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
    if (index >= 0) this.setups.splice(index, 1);
    if (this.setups.length === 0) {
      this.close();
      return;
    }
    const stream = this.stream;
    if (stream !== null && stream.ctx === registration.ctx) {
      // The owner is gone but others remain: re-elect by restarting the stream
      // against a surviving context instead of reporting nothing.
      stream.controller.abort();
      this.stream = null;
      this.startStream();
    }
  }

  private ctx(): any {
    return this.setups[0]?.ctx ?? null;
  }

  /** The context loaded for a directory, for location-scoped reads. */
  private ctxFor(directory: string | null): any {
    if (directory === null) return null;
    return this.setups.find((setup) => setup.directory === directory)?.ctx ?? null;
  }

  private send(action: Action): void {
    const write: Write =
      action.type === "delete"
        ? { type: "delete", sessionID: action.sessionID }
        : { type: "post", sessionID: action.sessionID, status: action.status, name: action.name };
    this.delivery.enqueue(write);
  }

  private bump(sessionID: string): void {
    this.versions.set(sessionID, (this.versions.get(sessionID) ?? 0) + 1);
  }

  private unchanged(sessionID: string, mark: number): boolean {
    return (this.versions.get(sessionID) ?? 0) === mark;
  }

  private dispatch(input: Input): void {
    if (this.closed) return;
    try {
      for (const action of reduce(this.state, input)) this.send(action);
    } catch {
      // A reducer fault must never surface in the host's event loop.
    }
  }

  private enqueueFor(sessionID: string, work: () => Promise<void> | void): void {
    const previous = this.chains.get(sessionID) ?? Promise.resolve();
    const next = previous.then(work).catch(() => undefined);
    this.chains.set(sessionID, next);
    void next.then(() => {
      if (this.chains.get(sessionID) === next) this.chains.delete(sessionID);
    });
  }

  private viewOf(info: any): SessionView {
    return {
      id: String(info.id),
      parentID: info.parentID ?? null,
      title: info.title ?? null,
      directory: info.location?.directory ?? null,
      executing: isExecuting(info, this.bootSince),
    };
  }

  /**
   * Resolve one session's metadata and admit it as a resident.
   *
   * Deliberately NOT version-fenced: a rename arriving while this read is in
   * flight must not invalidate it, because the queued event waiting on this
   * admission (a prompt, a start) has nowhere else to go — dropping the read
   * loses that event for good. Admission is identity only, and every later
   * event applies on top in arrival order.
   */
  private async discover(sessionID: string): Promise<void> {
    let info: any;
    try {
      info = await within(Promise.resolve(this.ctx()?.session?.get?.({ sessionID })));
    } catch {
      return; // unknown or gone: nothing to admit
    }
    if (info === TIMEOUT || this.closed) return;
    const row = info?.data ?? info;
    if (!row?.id) return;
    // An archived row still answers reads, and a delete for a session this
    // reporter never tracked leaves no trace. Admitting it would resurrect a
    // resident the user removed, so it is refused here as well.
    if (isArchived(row)) {
      if (this.knownRemoved(sessionID)) this.dispatch({ kind: "deleted", sessionID });
      return;
    }
    // A confirmed-gone session comes back only for a row that is provably live:
    // a fresh, non-archived read, which is exactly what this path just proved.
    this.dispatch({ kind: "discovered", sessions: [this.viewOf(row)] });
  }

  private knownRemoved(sessionID: string): boolean {
    return (this.state.sessions.get(sessionID)?.removed ?? false) || this.removed.has(sessionID);
  }

  private async ensure(sessionID: string): Promise<void> {
    const tracked = this.state.sessions.get(sessionID);
    // A removed session needs a fresh non-archived row to come back, so it is
    // re-read rather than assumed alive.
    if (tracked && !tracked.removed) return;
    await this.discover(sessionID);
  }

  /** Page the whole session list: the API returns 50 newest by default. */
  private async allRows(): Promise<SessionRow[] | null> {
    const rows: SessionRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SEED_MAX_PAGES; page += 1) {
      let listed: any;
      try {
        listed = await within(
          Promise.resolve(
            this.ctx()?.session?.list?.({ limit: SEED_PAGE, ...(cursor ? { cursor } : {}) }),
          ),
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

  /** Seed sessions executing at load; false when the list read failed. */
  private async seed(): Promise<boolean> {
    const marks = new Map(this.versions);
    const rows = await this.allRows();
    // A failed bootstrap is retried by the next pass: without it a session that
    // started while the list was down would never be found.
    if (rows === null || this.closed) return false;
    const views: SessionView[] = [];
    for (const row of rows) {
      if (!row.id || row.parentID || isArchived(row) || !isExecuting(row, this.bootSince)) continue;
      // A newer event for this session already reported it: a seeded view may
      // be older than that event, so it must not overwrite it.
      if (!this.unchanged(row.id, marks.get(row.id) ?? 0)) continue;
      views.push(this.viewOf(row));
    }
    if (views.length > 0) this.dispatch({ kind: "discovered", sessions: views });
    return true;
  }

  /** One session's ground truth: gone, executing, name, pending prompts. */
  private async check(sessionID: string): Promise<void> {
    const v = this.versions.get(sessionID) ?? 0;
    let info: any;
    try {
      info = await within(this.ctx()?.session?.get?.({ sessionID }));
    } catch (error) {
      // A specific not-found is authoritative; a failed or timed-out read is
      // not, so the resident stays until the next pass.
      if (isMissing(error) && this.unchanged(sessionID, v)) {
        this.dispatch({ kind: "reconcile", sessionID, view: null, missing: true });
      }
      return;
    }
    if (info === TIMEOUT || this.closed || !this.unchanged(sessionID, v)) return;
    const row = info?.data ?? info;
    if (!row?.id) return;
    if (isArchived(row)) {
      this.dispatch({ kind: "reconcile", sessionID, view: null, missing: true });
      return;
    }
    const view = this.viewOf(row);
    // Prompt reads are location-scoped: only the context loaded for this
    // session's own directory can describe its prompts. Without one, the
    // session stays event-only rather than being read from the wrong place.
    let permissions: readonly string[] | null | undefined;
    const locationCtx = this.ctxFor(view.directory ?? null);
    if (locationCtx) {
      const read = await readPermissions(locationCtx, sessionID);
      if (!this.unchanged(sessionID, v)) return;
      permissions = read;
    }
    this.dispatch({ kind: "reconcile", sessionID, view, permissions });
  }

  /** A reconcile pass over everything this reporter owns. */
  private async reconcile(first: boolean): Promise<void> {
    if (this.closed) return;
    // Recovery for a bootstrap that never landed: the pass keeps trying on
    // every reconnect and heartbeat until one succeeds.
    const bootstrapped = first ? await this.seed() : this.seeded;
    if (bootstrapped) this.seeded = true;
    for (const sessionID of liveSessions(this.state)) {
      if (this.closed) return;
      await this.check(sessionID);
    }
  }

  /**
   * One reconcile pass at a time, for startup, every reconnect and every
   * heartbeat. Overlapping passes would race: two reads for the same session
   * can return in either order and neither bumps a version, so a late stale
   * read would win. A pass requested while one runs is folded into one more.
   */
  private runReconcile(first: boolean): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void (async () => {
      try {
        let bootstrap = first;
        do {
          this.again = false;
          await this.reconcile(bootstrap);
          bootstrap = false;
        } while (this.again && !this.closed);
      } catch {
        // A pass fault must never surface in the host's event loop.
      } finally {
        this.running = false;
      }
    })();
  }

  private onEvent(event: any): void {
    const data = event?.data;
    if (!data) return;
    switch (event?.type) {
      case "session.created":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.bump(sessionID);
          this.enqueueFor(sessionID, () => this.discover(sessionID));
        }
        return;
      case "session.renamed":
        if (typeof data.sessionID === "string" && "title" in data) {
          const sessionID = data.sessionID;
          const title = typeof data.title === "string" ? data.title : null;
          this.bump(sessionID);
          this.enqueueFor(sessionID, async () => {
            await this.ensure(sessionID);
            this.dispatch({ kind: "renamed", sessionID, title });
          });
        }
        return;
      case "session.execution.started":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.bump(sessionID);
          this.enqueueFor(sessionID, async () => {
            await this.ensure(sessionID);
            this.dispatch({ kind: "execution-started", sessionID });
          });
        }
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.bump(sessionID);
          this.enqueueFor(sessionID, async () => {
            // A start that never resolved must not swallow the end.
            await this.ensure(sessionID);
            this.dispatch({ kind: "execution-ended", sessionID });
          });
        }
        return;
      case "permission.asked":
        if (typeof data.sessionID === "string" && typeof data.id === "string") {
          const sessionID = data.sessionID;
          const requestID = data.id;
          this.bump(sessionID);
          this.enqueueFor(sessionID, async () => {
            await this.ensure(sessionID);
            this.dispatch({ kind: "permission-asked", sessionID, requestID });
          });
        }
        return;
      case "permission.replied":
        if (typeof data.sessionID === "string" && typeof data.requestID === "string") {
          const sessionID = data.sessionID;
          const requestID = data.requestID;
          this.bump(sessionID);
          this.enqueueFor(sessionID, () =>
            this.dispatch({ kind: "permission-replied", sessionID, requestID }),
          );
        }
        return;
      case "form.created": {
        const formID = data?.form?.id;
        const sessionID = data?.form?.sessionID;
        if (typeof sessionID === "string" && typeof formID === "string") {
          this.bump(sessionID);
          this.enqueueFor(sessionID, async () => {
            await this.ensure(sessionID);
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
          this.bump(sessionID);
          this.enqueueFor(sessionID, () => this.dispatch({ kind, sessionID, formID }));
        }
        return;
      case "session.deleted":
      case "session.archived":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.bump(sessionID);
          // Remember it even when it was never tracked: the DELETE that follows
          // clears the resident, and this keeps a later rename or metadata read
          // from admitting the row again.
          this.removed.add(sessionID);
          // Behind any pending lookup, so a delete always outranks the birth
          // that lookup was about to report.
          this.enqueueFor(sessionID, () => this.dispatch({ kind: "deleted", sessionID }));
        }
        return;
      default:
        return;
    }
  }

  private startStream(): void {
    if (this.closed || this.stream || this.setups.length === 0) return;
    const ctx = this.ctx();
    const controller = new AbortController();
    this.stream = { controller, ctx };
    void (async () => {
      // A dropped stream is retried, because events are the only live signal:
      // an ended stream must not leave the town frozen on stale state.
      while (!this.closed && !controller.signal.aborted) {
        try {
          const events = ctx?.event?.subscribe?.({ signal: controller.signal });
          // Start consuming before reconciling. An async generator is
          // pull-based: while the read is awaiting, nothing is reading it and
          // every event in that window is lost.
          const reader = (async () => {
            for await (const event of events ?? []) this.onEvent(event);
          })();
          // Every reconnect re-bootstraps: a session can have started and
          // finished entirely while the stream was down, and only a fresh list
          // read can find it.
          this.runReconcile(true);
          await reader;
        } catch {
          // Fall through to the backoff below.
        }
        if (this.closed || controller.signal.aborted) return;
        await new Promise((resolve) => {
          const retry = setTimeout(resolve, RECONNECT_MS);
          (retry as unknown as { unref?: () => void }).unref?.();
        });
      }
    })().finally(() => {
      if (this.stream?.controller === controller) this.stream = null;
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
      // Renewal is independent of reading: a stalled metadata read must never
      // hold back the lease on sessions that are perfectly healthy.
      this.dispatch({ kind: "tick" });
      this.runReconcile(false);
    }, Math.min(60_000, HEARTBEAT_MS));
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();
  }

  private close(): void {
    this.closed = true;
    this.stream?.controller.abort();
    this.stream = null;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.delivery.close();
    this.chains.clear();
  }
}

const REGISTRY = Symbol.for("agent-machi.reporter");

function reporters(): Map<string, Reporter> {
  const host = globalThis as unknown as Record<symbol, Map<string, Reporter> | undefined>;
  return (host[REGISTRY] ??= new Map());
}

/** Keyed by everything that decides where writes go. */
function keyOf(config: Config): string {
  return [config.bridgeUrl.toString(), config.machineId, config.source, config.token].join("\n");
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
    const registration: Registration = {
      directory: typeof ctx?.location?.directory === "string" ? ctx.location.directory : null,
      ctx,
    };
    reporter.register(registration);

    return () => {
      reporter.unregister(registration);
      if (!reporter.live) registry.delete(key);
    };
  },
};

export default AgentMachiReporter;
