# tako 蛸

The centre of a small suite of standalone tools: an idea graph
(**tako-nerve**), a work board (**tako-arm**), a slides compiler
(**tako-skin**) and, later, a chat layer (**tako-ink**). The tools never
share code with each other. They share **one portable project file**, and
this repo defines it and lets them work on it together:

- **The project format** — one versioned JSON document (a *tako file*,
  `*.tako.json`): nodes, edges, legend, work items, artifacts and narratives
  (named paths through the graph). `schemaVersion` is bumped on breaking
  changes; `migrateProject` upgrades older documents.
- **The operations layer** — every change to a project is an `Op`, applied
  by one pure reducer (`applyOp` / `applyOps`, atomic). UIs, the hub and
  chat all use the same ops.
- **The hub** — a small local program that keeps projects as files in one
  folder and lets every tool open, edit and follow them at once.
- **Validation** — zod schemas for projects and for ops arriving from
  outside a UI (`parseOps`); patches never carry defaults.
- **Review** — `reviewOps` describes an op list in plain language and checks
  it still applies, for "apply / reject" diff cards.
- **Fixture projects** in `fixtures/` — golden documents every tool runs as
  contract tests.

## The hub

```sh
npm install
npm start                      # or: npx tako [--dir <folder>] [--port <n>]
```

```
tako 0.3.0
  projects  /home/you/tako  (3 projects)
  home      http://localhost:4100/
  arm       http://localhost:4100/arm/  Work board
  nerve     http://localhost:4100/nerve/  Graph
  skin      http://localhost:4100/skin/  Slides
```

One command, one address: the home page lists your projects and the tools
you have, and each project opens in any of them.

### Tools

```sh
npx tako add evilbagooba/tako-nerve    # the idea graph
npx tako add evilbagooba/tako-arm      # the work board
npx tako add evilbagooba/tako-skin     # slides
npx tako tools                         # what's installed
npx tako remove arm
```

`tako add <owner/repo>` downloads the built page from that repo's latest
GitHub release into `~/tako/tools/<id>/`, and the hub serves it at
`/<id>/`. `tako add <folder>` installs a page you built yourself. An
installed tool is a page running on your machine with full access to your
projects, so add tools the way you'd install any program.

The hub knows nothing about any particular tool. A tool describes itself in
one small file at the root of its built page, `tako.tool.json`:

```json
{
  "id": "arm",
  "name": "tako-arm",
  "title": "Work board",
  "tagline": "Every task knows which idea it came from.",
  "opens": ["project", "node", "work"],
  "version": "0.3.0"
}
```

So a new tool is one new repo: a static page that uses `tako/client`, with
that file in it and a release containing `tako-tool.tgz` (the built page,
gzipped). Nothing in the hub or in the other tools changes. Tools find each
other through the hub (`hub.tools()`), and link to each other with
`hub.linkTo(tool, { project, node, work })`, which opens the same project,
node or work item there. A tool you are working on (running from its own
dev server) announces itself to the hub and takes the place of the installed
copy while it runs.

Projects live in `~/tako/` (or `--dir` / `$TAKO_DIR`) as plain files you can
read, back up and put under git. A tool that finds the hub lists those
projects; a tool that doesn't falls back to opening a file. No tool needs
another tool to be running.

How tools stay in step:

- **Edits in, whole projects out.** A tool sends a small op list. The hub
  applies it to the latest version, saves the file, and answers with the
  whole project. Every other open tool is told the project changed, takes
  the fresh copy, and re-applies anything of its own not yet sent. Edits to
  different things from two tools both land; an edit whose target was
  removed elsewhere is dropped, and the tool says so.
- **Undo lives on the hub**, as one shared history per project, so a change
  made in one tool can be undone from another. It starts empty each time
  the hub does.
- **Files are the truth.** A project edited by hand, or replaced by git, is
  picked up and pushed to open tools (with a fresh undo history).
- **Every edit is logged** in `.tako/log/<project>.jsonl`: when, who, via
  which tool, and the ops. Deleted projects move to `.tako/trash/`.
- **Local only.** The hub listens on 127.0.0.1, answers only requests
  addressed to localhost, and only lets pages served from localhost read
  its answers.

HTTP API (JSON): `GET /api/health`, `GET /api/tools`,
`POST /api/tools/announce`, `GET|POST /api/projects`,
`GET|DELETE /api/projects/:id`, `POST /api/projects/:id/ops`
(`{ batches: [{ ops, coalesceKey? }], author?, via? }`),
`POST /api/projects/:id/undo|redo`, `POST /api/check-ops`, and
`GET /api/events` (server-sent events).

## Use in a tool

Pin a tag; tools upgrade at their own pace:

```sh
npm install github:evilbagooba/tako#v0.3.0 zod
```

```ts
// Browser code: zod-free (types, ops, history, reviewOps, local store).
import { applyOps, createLocalStore, type Project, type ProjectStore } from "tako/model";
// Browser code: find the hub and open projects on it.
import { findHub } from "tako/client";
// Importers, tests, servers: adds the zod schemas and migration.
import { migrateProject, parseOps } from "tako";
```

A tool edits a project through one interface, `ProjectStore`, whether the
project came from the hub or from a file:

```ts
const hub = await findHub({ tool: manifest });  // null when no hub is running
const store = hub
  ? await hub.open("my-project")                // shared, saved as you go
  : createLocalStore(migrateProject(fileJson)); // in this page; you save it

store.subscribe(render);                        // fits React's useSyncExternalStore
store.dispatch([{ type: "set_title", title: "New title" }]);
store.preview([...]); store.commitPreview();    // a drag: local until released
store.undo();
```

Shipped as TypeScript source, so consumers need a TS-aware toolchain (Vite,
tsx, Bun, esbuild). `zod` is a peer dependency, needed only by `tako` /
`tako/schema`; `tako/model` and `tako/client` import nothing from it at
runtime.

### Contract tests in a consuming tool

```ts
import { readFileSync } from "node:fs";
import { migrateProject } from "tako";

for (const name of ["bird-feeder.json", "sourdough.json", "v0-unversioned.json"]) {
  const doc = JSON.parse(readFileSync(new URL(import.meta.resolve(`tako/fixtures/${name}`)), "utf8"));
  const project = migrateProject(doc);
  // …open it with your tool and assert it still works.
}
```

## Develop

```sh
npm install
npm run typecheck
npm test          # ops, history, fixtures, and the hub end to end
```

Adding an op: its case in `applyOp` (`src/ops.ts`), its schema in `opSchema`
(`src/schema.ts`; a test checks the two match) and its description in
`describeOp` (`src/describe.ts`).

Layout: `src/project.ts`, `ops.ts`, `history.ts`, `describe.ts`, `store.ts`
(zod-free model); `src/schema.ts` (zod); `src/client.ts` (browser side of
the hub); `src/hub/` (the hub itself, Node only: `projects.ts` the project
folder, `tools.ts` installed and announced tools, `server.ts` the HTTP face,
`home.html` the home page, `main.ts` the command); `bin/tako.mjs`.
