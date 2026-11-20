// The browser side of the hub: find it, list and open projects, and keep an
// open project in step with every other tool that has it open.
//
// zod-free and DOM-light (fetch, plus EventSource where it exists), so it's
// safe in client bundles and usable from Node (agents, tests).
//
// The rule for an open project is "edits in, whole projects out": the page
// sends small op lists; the hub applies them to its latest version and
// answers with the whole project; when another tool changes the project the
// hub says so, and the page takes the fresh copy and re-applies whatever of
// its own it hasn't sent yet. Undo lives on the hub, so it works across
// tools.

import { OpError, applyOps, type Op } from "./ops";
import type { Project } from "./project";
import { createEmitter, type ProjectStore, type StoreSnapshot } from "./store";

export const DEFAULT_HUB = "http://localhost:4100";

export type ProjectSummary = {
  id: string;
  title: string;
  /** ISO time the file last changed. */
  updatedAt: string;
  rev: string;
  nodes: number;
  edges: number;
  work: number;
  narratives: number;
};

/** A project as the hub holds it. `rev` changes whenever the file does. */
export type HubDoc = { id: string; rev: string; project: Project; canUndo: boolean; canRedo: boolean };

export type HubEvent =
  | { type: "project"; id: string; rev: string }
  | { type: "list" }
  /** The set of reachable tools changed. */
  | { type: "tools" }
  | { type: "resync" };

/** How a tool describes itself (`tako.tool.json` at the root of its page).
 * This is all the hub, or any other tool, knows about it. */
export type ToolManifest = {
  /** Short and URL-safe; an installed tool is served at `/<id>/`. */
  id: string;
  name: string;
  /** What it is, in a word or two: "Work board". */
  title: string;
  tagline: string;
  /** What a link can point it at. */
  opens: ("project" | "node" | "work")[];
  version: string;
};

/** A tool that's reachable right now. */
export type ToolInfo = ToolManifest & { url: string; /** Announced by a running dev copy. */ dev: boolean };

/** What a link into another tool points at. */
export type LinkTarget = { project: string; node?: string; work?: string };

export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The hub's current copy, when it rejected an edit. */
    readonly doc?: HubDoc,
  ) {
    super(message);
  }
}

export type OpenOptions = {
  /** Called when an edit that looked fine here was refused by the hub, or
   * no longer applies after someone else's change. */
  onRejected?: (message: string) => void;
};

export type Hub = {
  readonly url: string;
  readonly version: string;
  /** The folder the hub keeps projects in, for display. */
  readonly dir: string;
  list(): Promise<ProjectSummary[]>;
  /** Create a project from a title, or import a document (any supported
   * version; the hub migrates and validates it). */
  create(input: { title: string } | { document: unknown; fallbackTitle?: string }): Promise<HubDoc>;
  get(id: string): Promise<HubDoc>;
  remove(id: string): Promise<void>;
  /** Validate an op list from outside a UI (pasted, or from an agent). */
  checkOps(raw: unknown): Promise<Op[]>;
  /** Open a project for editing. */
  open(id: string, opts?: OpenOptions): Promise<ProjectStore>;
  /** Hear about changes to any project, or to the list of projects. */
  onEvent(listener: (e: HubEvent) => void): () => void;
  /** Every tool reachable right now (installed in the hub, or running and
   * announced), this one included. */
  tools(): Promise<ToolInfo[]>;
  /** An address that opens `target` in `tool`. Only what the tool says it
   * can open is passed along. */
  linkTo(tool: ToolInfo, target: LinkTarget): string;
};

/** The page's address, where there is a page (no DOM types here: this
 * module also runs in Node). */
const pageLocation = () =>
  (globalThis as { location?: { search: string; origin: string; pathname: string; protocol: string } }).location;

/** What a link into this page asked for (`?project=…&node=…&work=…`). */
export function linkTarget(search: string = pageLocation()?.search ?? ""): Partial<LinkTarget> {
  const q = new URLSearchParams(search);
  const get = (k: string) => q.get(k) || undefined;
  return { project: get("project"), node: get("node"), work: get("work") };
}

/**
 * Find the hub for this page: `?hub=<url>` if given, else the page's own
 * origin (a tool installed in the hub is served by it), else the default
 * address. Null when none answers.
 */
export async function findHub(opts: { tool?: ToolManifest; timeoutMs?: number } = {}): Promise<Hub | null> {
  const loc = pageLocation();
  const asked = loc ? new URLSearchParams(loc.search).get("hub") : null;
  const candidates = asked ? [asked] : [...(loc && /^https?:$/.test(loc.protocol) ? [loc.origin] : []), DEFAULT_HUB];
  for (const url of [...new Set(candidates)]) {
    const hub = await connectHub(url, opts);
    if (hub) return hub;
  }
  return null;
}

type EventSourceLike = {
  onmessage: ((e: { data: string }) => void) | null;
  onopen: (() => void) | null;
  close(): void;
};

/** Find a hub. Resolves null (quickly) when none is running, which is the
 * signal to fall back to opening a file. */
export async function connectHub(
  url: string = DEFAULT_HUB,
  opts: { timeoutMs?: number; clientName?: string; tool?: ToolManifest } = {},
): Promise<Hub | null> {
  const base = url.replace(/\/+$/, "");
  let health: { name?: string; version?: string; dir?: string };
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 800) });
    if (!res.ok) return null;
    health = (await res.json()) as typeof health;
  } catch {
    return null; // nothing there, or something that isn't a hub
  }
  if (health.name !== "tako") return null;

  const clientId = Math.random().toString(36).slice(2, 10);
  const via = opts.clientName ?? opts.tool?.name ?? "";

  async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; doc?: HubDoc };
    if (!res.ok) throw new HubError(data.error ?? `The hub answered ${res.status}.`, res.status, data.doc);
    return data as T;
  }

  // One event stream per page, opened on first use and shared by everything.
  const events = createEmitter();
  let lastEvent: HubEvent = { type: "list" };
  let listeners = 0;
  let source: EventSourceLike | null = null;
  function onEvent(listener: (e: HubEvent) => void) {
    const off = events.subscribe(() => listener(lastEvent));
    listeners++;
    const ES = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
    if (!source && ES) {
      let opened = false;
      source = new ES(`${base}/api/events`);
      source.onmessage = (e) => {
        try {
          lastEvent = JSON.parse(e.data) as HubEvent;
        } catch {
          return;
        }
        events.emit();
      };
      // A reconnect means events may have been missed: everyone re-reads.
      source.onopen = () => {
        if (opened) {
          lastEvent = { type: "resync" };
          events.emit();
        }
        opened = true;
      };
    }
    return () => {
      off();
      if (--listeners === 0) {
        source?.close();
        source = null;
      }
    };
  }

  const hub: Hub = {
    url: base,
    version: health.version ?? "",
    dir: health.dir ?? "",
    list: async () => (await call<{ projects: ProjectSummary[] }>("/api/projects")).projects,
    create: (input) => call<HubDoc>("/api/projects", { method: "POST", body: { ...input, via } }),
    get: (id) => call<HubDoc>(`/api/projects/${encodeURIComponent(id)}`),
    remove: async (id) => void (await call(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" })),
    checkOps: async (raw) => (await call<{ ops: Op[] }>("/api/check-ops", { method: "POST", body: { ops: raw } })).ops,
    open: async (id, o) => createHubStore(await hub.get(id), o ?? {}),
    onEvent,
    tools: async () => (await call<{ tools: ToolInfo[] }>("/api/tools")).tools,
    linkTo(tool, target) {
      const url = new URL(tool.url);
      url.searchParams.set("project", target.project);
      if (target.node && tool.opens.includes("node")) url.searchParams.set("node", target.node);
      if (target.work && tool.opens.includes("work")) url.searchParams.set("work", target.work);
      // A tool not served by this hub has to be told where the hub is,
      // unless it would find it at the default address anyway.
      if (url.origin !== base && base !== DEFAULT_HUB) url.searchParams.set("hub", base);
      return url.href;
    },
  };

  // A tool running outside the hub (a dev server) says where it is, and
  // keeps saying so; the hub forgets tools that go quiet.
  const loc = pageLocation();
  if (opts.tool && loc && loc.origin !== base) {
    const here = `${loc.origin}${loc.pathname}`;
    const announce = () => void call("/api/tools/announce", { method: "POST", body: { manifest: opts.tool, url: here } }).catch(() => {});
    announce();
    setInterval(announce, 30_000);
  }

  type Batch = { ops: Op[]; coalesceKey?: string };

  function createHubStore(initial: HubDoc, { onRejected }: OpenOptions): ProjectStore {
    const path = `/api/projects/${encodeURIComponent(initial.id)}`;
    let server = initial;
    let inflight: Batch[] = []; // sent, not yet answered
    let pending: Batch[] = []; // not yet sent
    let previewOps: Op[] = []; // a gesture in progress: never sent as-is
    let offline = false;
    let busy = false; // a request is in the air (edits, undo or a refetch)
    let stale = false; // the hub announced a newer version while busy
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idle: (() => void)[] = [];
    let optimistic = server.project;
    let snapshot: StoreSnapshot = snap();
    const emitter = createEmitter();

    function snap(): StoreSnapshot {
      const unsent = inflight.length + pending.length > 0;
      return {
        project: optimistic,
        canUndo: server.canUndo || unsent,
        canRedo: server.canRedo && !unsent,
        sync: offline ? "offline" : unsent || busy ? "saving" : "saved",
      };
    }
    function publish() {
      snapshot = snap();
      emitter.emit();
    }

    /** The hub's copy plus everything of ours it hasn't confirmed. Edits
     * that no longer apply (their target was removed elsewhere) are dropped. */
    function rebase() {
      let p = server.project;
      let dropped = 0;
      const keep = (batches: Batch[]) =>
        batches.filter((b) => {
          try {
            p = applyOps(p, b.ops);
            return true;
          } catch {
            dropped++;
            return false;
          }
        });
      inflight = keep(inflight);
      pending = keep(pending);
      try {
        p = applyOps(p, previewOps);
      } catch {
        previewOps = [];
      }
      optimistic = p;
      if (dropped) onRejected?.("A change of yours no longer applies, because the project was changed elsewhere.");
    }

    function schedule(ms = 150) {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void pump();
      }, ms);
    }

    /** One request at a time: send what's waiting, or catch up if the hub
     * has moved on. */
    async function pump() {
      if (busy || closed) return;
      busy = true;
      try {
        if (pending.length) {
          inflight = pending;
          pending = [];
          publish();
          try {
            server = await call<HubDoc>(`${path}/ops`, { method: "POST", body: { batches: inflight, clientId, via } });
            inflight = [];
          } catch (e) {
            if (e instanceof HubError && e.status < 500) {
              // Refused: the hub's copy stands, and what we sent is dropped.
              inflight = [];
              if (e.doc) server = e.doc;
              onRejected?.(e.message);
            } else {
              throw e; // the hub is unreachable: keep everything, retry
            }
          }
          stale = false;
          offline = false;
          rebase();
        } else if (stale) {
          stale = false;
          server = await call<HubDoc>(path);
          offline = false;
          rebase();
        }
      } catch (e) {
        if (e instanceof HubError && e.status === 404) {
          onRejected?.("This project was removed from the hub.");
          closed = true;
        } else {
          pending = [...inflight, ...pending];
          inflight = [];
          offline = true;
        }
      } finally {
        busy = false;
      }
      publish();
      if (closed) return;
      if (offline) schedule(2000);
      else if (pending.length || stale) schedule(0);
      else {
        const waiting = idle;
        idle = [];
        for (const done of waiting) done();
      }
    }

    function flush(): Promise<void> {
      if (closed || (!busy && !pending.length && !stale)) return Promise.resolve();
      return new Promise((resolve) => {
        idle.push(resolve);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void pump();
      });
    }

    function commitPreview() {
      if (!previewOps.length) return;
      pending.push({ ops: previewOps });
      previewOps = [];
      publish();
      schedule();
    }

    async function step(which: "undo" | "redo") {
      commitPreview();
      await flush();
      if (busy || closed) return;
      busy = true;
      try {
        server = await call<HubDoc>(`${path}/${which}`, { method: "POST", body: { clientId, via } });
        offline = false;
        rebase();
      } catch (e) {
        if (!(e instanceof HubError)) offline = true;
      } finally {
        busy = false;
      }
      publish();
      if (pending.length || stale) schedule(0);
    }

    const off = onEvent((e) => {
      if (closed) return;
      if (e.type === "list" || e.type === "tools" || (e.type === "project" && (e.id !== server.id || e.rev === server.rev))) return;
      stale = true;
      schedule(0);
    });

    return {
      get: () => snapshot,
      subscribe: emitter.subscribe,
      dispatch(ops, opts) {
        if (!ops.length) return;
        commitPreview();
        optimistic = applyOps(optimistic, ops); // throws OpError before anything is queued
        const last = pending[pending.length - 1];
        // Typing: fold into the batch that's still waiting, so a burst of
        // keystrokes is one small request.
        if (last && opts?.coalesceKey !== undefined && last.coalesceKey === opts.coalesceKey) last.ops.push(...ops);
        else pending.push({ ops: [...ops], coalesceKey: opts?.coalesceKey });
        publish();
        schedule();
      },
      preview(ops) {
        const next = applyOps(optimistic, ops);
        for (const op of ops) {
          const last = previewOps[previewOps.length - 1];
          // A drag is a stream of moves of one node: keep only the latest.
          if (op.type === "move_node" && last?.type === "move_node" && last.id === op.id) previewOps[previewOps.length - 1] = op;
          else previewOps.push(op);
        }
        optimistic = next;
        publish();
      },
      commitPreview,
      undo: () => void step("undo"),
      redo: () => void step("redo"),
      flush,
      close() {
        // Send what's left, then stop listening.
        commitPreview();
        void flush().finally(() => {
          closed = true;
          off();
        });
      },
    };
  }

  return hub;
}

export { OpError };
