// The hub's store: a folder of project files, one `<id>.tako.json` each.
// The files are the truth. The hub is the one writer while it runs, but a
// file edited by hand (or replaced by git) is noticed and picked up.
//
// Beside the projects, in `.tako/`: an append-only log of every edit per
// project (who, when, what), and a trash that deleted projects move to.
// Undo history is kept in memory and starts empty each time the hub does.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "../history";
import { OpError, type Op } from "../ops";
import { emptyProject, normalizeProject, type Project } from "../project";
import { migrateProject, opListSchema, projectSchema } from "../schema";
import type { HubDoc, HubEvent, ProjectSummary } from "../client";

const EXT = ".tako.json";
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export class NotFound extends Error {}
/** The request itself is wrong (bad id, invalid document, an op that
 * can't apply). `doc` carries the hub's current copy where there is one. */
export class Rejected extends Error {
  constructor(
    message: string,
    readonly doc?: HubDoc,
  ) {
    super(message);
  }
}

export type Batch = { ops: unknown; coalesceKey?: string };
export type Who = { author?: string; via?: string; clientId?: string };

type Entry = { history: History; rev: string; mtimeMs: number; size: number };

const revOf = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
const serialize = (p: Project) => JSON.stringify(p, null, 2) + "\n";

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "project";
}

/** Long strings (inline images) are cut in the log; the file has them. */
function forLog(value: unknown): unknown {
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 200)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(forLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forLog(v)]));
  }
  return value;
}

export class ProjectFolder {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(e: HubEvent) => void>();
  private watcher: FSWatcher | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly dir: string) {
    mkdirSync(join(dir, ".tako", "log"), { recursive: true });
    mkdirSync(join(dir, ".tako", "trash"), { recursive: true });
    try {
      this.watcher = watch(dir, () => this.scheduleCheck());
    } catch {
      // No watching on this filesystem: hand edits are picked up on next read.
    }
  }

  close() {
    this.watcher?.close();
    if (this.checkTimer) clearTimeout(this.checkTimer);
  }

  on(listener: (e: HubEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private emit(e: HubEvent) {
    for (const l of [...this.listeners]) l(e);
  }

  private file(id: string) {
    if (!ID.test(id)) throw new Rejected(`"${id}" isn't a valid project id.`);
    return join(this.dir, id + EXT);
  }
  private ids(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(EXT) && ID.test(f.slice(0, -EXT.length)))
      .map((f) => f.slice(0, -EXT.length))
      .sort();
  }

  /** The folder changed under us (or might have): re-read what differs and
   * tell the tools. Debounced, since one save is several fs events. */
  private scheduleCheck() {
    if (this.checkTimer) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      let listChanged = false;
      for (const id of [...this.entries.keys()]) {
        if (!existsSync(join(this.dir, id + EXT))) {
          this.entries.delete(id);
          listChanged = true;
          continue;
        }
        const before = this.entries.get(id)!.rev;
        try {
          if (this.load(id).rev !== before) this.emit({ type: "project", id, rev: this.entries.get(id)!.rev });
        } catch {
          // Half-written or invalid right now: keep what we have.
        }
      }
      if (listChanged || this.ids().some((id) => !this.entries.has(id))) listChanged = true;
      if (listChanged) this.emit({ type: "list" });
    }, 120);
  }

  /** The current entry for a project, re-read from disk if the file isn't
   * the one we last wrote or read. A file that changed outside the hub
   * starts a fresh undo history: its past isn't ours to step back through. */
  private load(id: string): Entry {
    const file = this.file(id);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      this.entries.delete(id);
      throw new NotFound(`No project "${id}".`);
    }
    const cached = this.entries.get(id);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const text = readFileSync(file, "utf8");
    const rev = revOf(text);
    if (cached && cached.rev === rev) {
      cached.mtimeMs = stat.mtimeMs;
      cached.size = stat.size;
      return cached;
    }
    let project: Project;
    try {
      project = migrateProject(JSON.parse(text), id);
    } catch {
      throw new Rejected(`"${id}${EXT}" isn't a project file this version can read.`);
    }
    const entry = { history: createHistory(project), rev, mtimeMs: stat.mtimeMs, size: stat.size };
    this.entries.set(id, entry);
    return entry;
  }

  private write(id: string, history: History): Entry {
    const file = this.file(id);
    const text = serialize(history.present);
    // Write beside, then rename: a reader never sees half a file.
    const tmp = join(this.dir, ".tako", `${id}.${process.pid}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    const stat = statSync(file);
    const entry = { history, rev: revOf(text), mtimeMs: stat.mtimeMs, size: stat.size };
    this.entries.set(id, entry);
    return entry;
  }

  private log(id: string, who: Who, what: Record<string, unknown>) {
    const line = { at: new Date().toISOString(), author: who.author ?? "user", via: who.via ?? "", ...what };
    try {
      appendFileSync(join(this.dir, ".tako", "log", `${id}.jsonl`), JSON.stringify(forLog(line)) + "\n");
    } catch {
      // The log is a record, not a dependency: a failed append never blocks an edit.
    }
  }

  private doc(id: string, e: Entry): HubDoc {
    return { id, rev: e.rev, project: e.history.present, canUndo: canUndo(e.history), canRedo: canRedo(e.history) };
  }

  list(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const id of this.ids()) {
      try {
        const e = this.load(id);
        const p = e.history.present;
        out.push({
          id,
          title: p.title,
          updatedAt: new Date(e.mtimeMs).toISOString(),
          rev: e.rev,
          nodes: p.nodes.length,
          edges: p.edges.length,
          work: p.work.length,
          narratives: p.narratives.length,
        });
      } catch {
        // Not a readable project: left alone, and left out.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): HubDoc {
    return this.doc(id, this.load(id));
  }

  create(input: { title?: unknown; document?: unknown; fallbackTitle?: unknown }, who: Who = {}): HubDoc {
    let project: Project;
    if (input.document !== undefined) {
      const fallback = typeof input.fallbackTitle === "string" && input.fallbackTitle.trim() ? input.fallbackTitle.trim().slice(0, 120) : "Imported project";
      try {
        project = migrateProject(input.document, fallback);
      } catch {
        throw new Rejected("That isn't a project file this version can read.");
      }
    } else {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) throw new Rejected("Give the project a title first.");
      if (title.length > 120) throw new Rejected("That title is too long (120 characters at most).");
      project = emptyProject(title);
    }
    const taken = new Set(this.ids());
    const base = slugify(project.title);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const entry = this.write(id, createHistory(project));
    this.log(id, who, { created: project.title });
    this.emit({ type: "list" });
    return this.doc(id, entry);
  }

  /** Move to the trash (`.tako/trash/`), never unlink. */
  remove(id: string, who: Who = {}) {
    this.load(id);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(this.file(id), join(this.dir, ".tako", "trash", `${id}.${stamp}${EXT}`));
    this.entries.delete(id);
    this.log(id, who, { removed: true });
    this.emit({ type: "list" });
  }

  /** Apply batches in order to the latest version, each as one undo step.
   * Stops at the first that can't apply: earlier ones stay, and the error
   * carries the current copy so the sender can catch up. */
  apply(id: string, batches: readonly Batch[], who: Who = {}): HubDoc {
    let entry = this.load(id);
    let history = entry.history;
    const applied: Op[][] = [];
    let failure: string | null = null;
    for (const batch of batches) {
      const parsed = opListSchema.safeParse(batch.ops);
      if (!parsed.success) {
        failure = "That edit isn't a valid list of ops.";
        break;
      }
      const ops = parsed.data as Op[];
      try {
        const key = batch.coalesceKey === undefined ? undefined : `${who.clientId ?? ""}:${batch.coalesceKey}`;
        const next = commit(history, ops, { coalesceKey: key });
        // Ops are valid one by one; this catches a project grown past its limits.
        projectSchema.parse(next.present);
        history = next;
        applied.push(ops);
      } catch (e) {
        failure = e instanceof OpError ? e.message : "That edit would leave the project invalid.";
        break;
      }
    }
    if (history !== entry.history) {
      const tidy = normalizeProject(history.present);
      entry = this.write(id, tidy === history.present ? history : { ...history, present: tidy });
      this.log(id, who, { ops: applied.flat(), rev: entry.rev });
      this.emit({ type: "project", id, rev: entry.rev });
      this.emit({ type: "list" });
    }
    const doc = this.doc(id, entry);
    if (failure) throw new Rejected(failure, doc);
    return doc;
  }

  step(id: string, which: "undo" | "redo", who: Who = {}): HubDoc {
    const entry = this.load(id);
    const history = which === "undo" ? undo(entry.history) : redo(entry.history);
    if (history === entry.history) return this.doc(id, entry);
    const next = this.write(id, history);
    this.log(id, who, { [which]: true, rev: next.rev });
    this.emit({ type: "project", id, rev: next.rev });
    this.emit({ type: "list" });
    return this.doc(id, next);
  }
}
