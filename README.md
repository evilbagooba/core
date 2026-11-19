# core

The contract shared by a small suite of standalone tools (an idea graph, a
work tracker, a slides renderer, a chat layer). The tools never share code
or a backend at runtime; they share **one portable project file**, and this
repo defines it:

- **The project format** — one versioned JSON document: nodes, edges,
  legend, work items, artifacts and narratives (named paths through the
  graph). `schemaVersion` is bumped on breaking changes; `migrateProject`
  upgrades older documents.
- **The operations layer** — every change to a project is an `Op`, applied
  by one pure reducer (`applyOp` / `applyOps`, atomic). UIs and chat produce
  the same ops.
- **Undo history** — snapshot undo/redo with coalescing (`commit`, `undo`,
  `redo`, and `preview` / `commitFrom` for drags).
- **Validation** — zod schemas for projects and for ops arriving from
  outside a UI (`parseOps`); patches never carry defaults.
- **Review** — `reviewOps` describes an op list in plain language and checks
  it still applies, for "apply / reject" diff cards.
- **Fixture projects** in `fixtures/` — golden documents every tool runs as
  contract tests.

Framework-free: no React, no DOM.

## Use

Pin a tag; tools upgrade at their own pace:

```sh
npm install github:evilbagooba/core#v0.1.0 zod
```

```ts
// Browser code: zod-free (types, ops, history, reviewOps).
import { applyOps, createHistory, commit, type Project } from "core/model";
// Servers, importers, tests: adds the zod schemas and migration.
import { migrateProject, parseOps } from "core";
```

Shipped as TypeScript source, so consumers need a TS-aware toolchain (Vite,
tsx, Bun, esbuild). `zod` is a peer dependency, needed only by `core` /
`core/schema`; `core/model` imports nothing from it at runtime.

### Contract tests in a consuming tool

```ts
import { readFileSync } from "node:fs";
import { migrateProject } from "core";

for (const name of ["bird-feeder.json", "sourdough.json", "v0-unversioned.json"]) {
  const doc = JSON.parse(readFileSync(new URL(import.meta.resolve(`core/fixtures/${name}`)), "utf8"));
  const project = migrateProject(doc);
  // …open it with your tool and assert it still works.
}
```

## Develop

```sh
npm install
npm run typecheck
npm test
```

Adding an op: its case in `applyOp` (`src/ops.ts`), its schema in `opSchema`
(`src/schema.ts`; a test checks the two match) and its description in
`describeOp` (`src/describe.ts`).
