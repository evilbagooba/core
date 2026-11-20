// A project that's open for editing, wherever it lives. Tools talk to this
// one interface; behind it is either a project held in the page (opened
// from a file: `createLocalStore`) or one held by the hub (`tako/client`).
//
// Framework-free. `get()` returns the same object until something changes,
// so it plugs straight into React's useSyncExternalStore.

import { canRedo, canUndo, commit, commitFrom, createHistory, preview, redo, undo, type History } from "./history";
import type { Op } from "./ops";
import type { Project } from "./project";

export type StoreSnapshot = {
  readonly project: Project;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** local: lives in this page only (saving is the tool's job).
   * saved / saving / offline: held by the hub. */
  readonly sync: "local" | "saved" | "saving" | "offline";
};

export interface ProjectStore {
  get(): StoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Apply ops as one undoable step. Throws OpError (nothing changes) if
   * any op can't apply. Edits sharing a `coalesceKey` within a second merge
   * into one step. */
  dispatch(ops: readonly Op[], opts?: { coalesceKey?: string }): void;
  /** Apply ops without recording a step, for continuous gestures (a drag).
   * Nothing leaves the page until `commitPreview`. */
  preview(ops: readonly Op[]): void;
  /** Record everything previewed since the last commit as one step. */
  commitPreview(): void;
  undo(): void;
  redo(): void;
  /** Resolves once nothing is waiting to be sent. */
  flush(): Promise<void>;
  close(): void;
}

/** Listeners plus a cached snapshot: the plumbing both stores share. */
export function createEmitter() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit() {
      for (const l of [...listeners]) l();
    },
  };
}

/** A project that lives in this page, with core's snapshot undo. */
export function createLocalStore(project: Project): ProjectStore {
  let history: History = createHistory(project);
  let base: Project | null = null; // the project before a previewed gesture
  let snapshot: StoreSnapshot = snap();
  const emitter = createEmitter();

  function snap(): StoreSnapshot {
    return { project: history.present, canUndo: canUndo(history), canRedo: canRedo(history), sync: "local" };
  }
  function set(next: History) {
    if (next === history) return;
    history = next;
    snapshot = snap();
    emitter.emit();
  }
  const settle = () => {
    if (base === null) return;
    const from = base;
    base = null;
    set(commitFrom(history, from));
  };

  return {
    get: () => snapshot,
    subscribe: emitter.subscribe,
    dispatch(ops, opts) {
      settle();
      set(commit(history, ops, opts));
    },
    preview(ops) {
      base ??= history.present;
      set(preview(history, ops));
    },
    commitPreview: settle,
    undo() {
      settle();
      set(undo(history));
    },
    redo() {
      settle();
      set(redo(history));
    },
    flush: () => Promise.resolve(),
    close() {},
  };
}
