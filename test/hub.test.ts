// The hub end to end: a real server on a temp folder, with clients talking
// to it the way the tools do.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { connectHub, type Hub } from "../src/client";
import { createHub } from "../src/hub/server";
import { slugify } from "../src/hub/projects";
import { createLocalStore, migrateProject, type Op, type ProjectStore } from "../src/index";

// Node has no EventSource by default; this is enough of one for the client.
class TestEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  private ctl = new AbortController();
  constructor(url: string) {
    void (async () => {
      try {
        const res = await fetch(url, { signal: this.ctl.signal });
        this.onopen?.();
        let buf = "";
        for await (const chunk of res.body!) {
          buf += Buffer.from(chunk).toString("utf8");
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (frame.startsWith("data: ")) this.onmessage?.({ data: frame.slice(6) });
          }
        }
      } catch {
        /* closed */
      }
    })();
  }
  close() {
    this.ctl.abort();
  }
}
(globalThis as { EventSource?: unknown }).EventSource = TestEventSource;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as unknown;
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`Timed out waiting for: ${what}`);
};
const rename = (id: string, title: string): Op[] => [{ type: "update_node", id, patch: { title } }];

let dir: string;
let url: string;
let hubServer: ReturnType<typeof createHub>;
let a: Hub;
let b: Hub;
const open: ProjectStore[] = [];
const track = (s: ProjectStore) => (open.push(s), s);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tako-test-"));
  hubServer = createHub({ dir, version: "test" });
  await new Promise<void>((r) => hubServer.server.listen(0, "127.0.0.1", r));
  url = `http://localhost:${(hubServer.server.address() as AddressInfo).port}`;
  a = (await connectHub(url, { clientName: "test-a" }))!;
  b = (await connectHub(url, { clientName: "test-b" }))!;
  assert.ok(a && b);
});
after(async () => {
  for (const s of open) s.close();
  await new Promise((r) => setTimeout(r, 50));
  await hubServer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("hub", () => {
  it("is not found where nothing is listening", async () => {
    assert.equal(await connectHub("http://localhost:1", { timeoutMs: 300 }), null);
  });

  it("creates, imports, lists and trashes projects as files", async () => {
    const blank = await a.create({ title: "A fresh idea" });
    assert.equal(blank.id, "a-fresh-idea");
    assert.ok(existsSync(join(dir, "a-fresh-idea.tako.json")));
    const again = await a.create({ title: "A fresh idea" });
    assert.equal(again.id, "a-fresh-idea-2", "ids never collide");

    const old = await a.create({ document: fixture("v0-unversioned.json"), fallbackTitle: "From a v0 file" });
    assert.deepEqual(old.project, migrateProject(fixture("v0-unversioned.json"), "From a v0 file"));
    await assert.rejects(a.create({ document: { hello: 1 } }), /isn't a project file/);
    await assert.rejects(a.create({ title: "  " }), /title/);

    const ids = (await b.list()).map((p) => p.id);
    assert.ok(ids.includes(blank.id) && ids.includes(again.id) && ids.includes(old.id));

    await a.remove(again.id);
    assert.ok(!existsSync(join(dir, "a-fresh-idea-2.tako.json")));
    assert.equal(readdirSync(join(dir, ".tako", "trash")).filter((f) => f.startsWith("a-fresh-idea-2.")).length, 1);
    await assert.rejects(a.get(again.id), /No project/);
  });

  it("merges edits from two tools and keeps both in step", async () => {
    const { id } = await a.create({ document: fixture("sourdough.json") });
    const sa = track(await a.open(id));
    const sb = track(await b.open(id));
    const [n1, n2] = sa.get().project.nodes;

    sa.dispatch(rename(n1!.id, "Renamed in A"));
    sb.dispatch(rename(n2!.id, "Renamed in B"));
    assert.equal(sa.get().project.nodes[0]!.title, "Renamed in A", "an edit shows at once, before the hub answers");
    assert.equal(sa.get().sync, "saving");

    const titles = (s: ProjectStore) => s.get().project.nodes.slice(0, 2).map((n) => n.title);
    await until(() => titles(sa).join() === "Renamed in A,Renamed in B" && titles(sb).join() === titles(sa).join(), "both tools show both edits");
    await Promise.all([sa.flush(), sb.flush()]);
    assert.equal(sa.get().sync, "saved");
    const onDisk = JSON.parse(readFileSync(join(dir, `${id}.tako.json`), "utf8")) as { nodes: { title: string }[] };
    assert.deepEqual(onDisk.nodes.slice(0, 2).map((n) => n.title), ["Renamed in A", "Renamed in B"]);
  });

  it("undoes across tools: a change made in one is undone from another", async () => {
    const { id } = await a.create({ document: fixture("bird-feeder.json") });
    const sa = track(await a.open(id));
    const sb = track(await b.open(id));
    const node = sa.get().project.nodes[0]!;
    assert.equal(sb.get().canUndo, false);

    sa.dispatch(rename(node.id, "Changed"));
    await until(() => sb.get().project.nodes[0]!.title === "Changed" && sb.get().canUndo, "B sees A's change and can undo");
    sb.undo();
    await until(() => sa.get().project.nodes[0]!.title === node.title, "A sees the undo");
    await until(() => sa.get().canRedo, "redo is offered");
    sa.redo();
    await until(() => sb.get().project.nodes[0]!.title === "Changed", "B sees the redo");
  });

  it("typing coalesces into one undo step", async () => {
    const { id } = await a.create({ title: "Typing" });
    const s = track(await a.open(id));
    for (const title of ["T", "Ty", "Typ", "Typed"]) s.dispatch([{ type: "set_title", title }], { coalesceKey: "title" });
    await s.flush();
    s.undo();
    await until(() => s.get().project.title === "Typing", "one undo reverts the whole burst");
  });

  it("a drag previews locally and lands as one step", async () => {
    const { id } = await a.create({ document: fixture("bird-feeder.json") });
    const sa = track(await a.open(id));
    const sb = track(await b.open(id));
    const node = sa.get().project.nodes[0]!;
    for (let i = 1; i <= 30; i++) sa.preview([{ type: "move_node", id: node.id, x: node.x + i, y: node.y }]);
    assert.equal(sa.get().project.nodes[0]!.x, node.x + 30);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(sb.get().project.nodes[0]!.x, node.x, "nothing is sent mid-drag");
    sa.commitPreview();
    await until(() => sb.get().project.nodes[0]!.x === node.x + 30, "the drop arrives");
    sb.undo();
    await until(() => sa.get().project.nodes[0]!.x === node.x, "and is one undo step");
  });

  it("drops an edit whose target was removed elsewhere, and says so", async () => {
    const { id } = await a.create({ document: fixture("bird-feeder.json") });
    const rejected: string[] = [];
    const sa = track(await a.open(id));
    const sb = track(await b.open(id, { onRejected: (m) => rejected.push(m) }));
    const node = sa.get().project.nodes[1]!;
    sa.dispatch([{ type: "remove_node", id: node.id }]);
    await sa.flush();
    sb.dispatch(rename(node.id, "Too late")); // B hasn't caught up yet, or has: either way it must end consistent
    await until(() => !sb.get().project.nodes.some((n) => n.id === node.id) && sb.get().sync === "saved", "B converges on the hub's copy");
    assert.equal(rejected.length, 1);
    assert.deepEqual(sb.get().project, sa.get().project);
  });

  it("refuses ops that aren't valid, without touching the file", async () => {
    const { id, rev } = await a.create({ title: "Strict" });
    const res = await fetch(`${url}/api/projects/${id}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batches: [{ ops: [{ type: "set_title", title: 7 }] }] }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { doc: { rev: string } };
    assert.equal(body.doc.rev, rev);
    await assert.rejects(a.checkOps([{ type: "nope" }]), /Not a valid op list/);
    assert.deepEqual(await a.checkOps([{ type: "set_title", title: "ok" }]), [{ type: "set_title", title: "ok" }]);
  });

  it("picks up a file edited by hand", async () => {
    const { id } = await a.create({ title: "By hand" });
    const s = track(await a.open(id));
    s.dispatch([{ type: "set_title", title: "By the hub" }]);
    await s.flush();
    assert.equal(s.get().canUndo, true);
    const file = join(dir, `${id}.tako.json`);
    const doc = JSON.parse(readFileSync(file, "utf8")) as { title: string };
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, JSON.stringify({ ...doc, title: "Edited in an editor" }, null, 2));
    await until(() => s.get().project.title === "Edited in an editor", "the open tool reloads");
    assert.equal(s.get().canUndo, false, "its past isn't the hub's to step through");
  });

  it("logs every edit with who made it", async () => {
    const { id } = await a.create({ title: "Logged" });
    const s = track(await a.open(id));
    s.dispatch([{ type: "set_title", title: "Logged twice" }]);
    await s.flush();
    const lines = readFileSync(join(dir, ".tako", "log", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines[0]!.created, "Logged");
    assert.deepEqual(lines[1]!.ops, [{ type: "set_title", title: "Logged twice" }]);
    assert.equal(lines[1]!.author, "user");
    assert.equal(lines[1]!.via, "test-a");
    assert.ok(typeof lines[1]!.at === "string");
  });

  it("answers only localhost pages", async () => {
    const elsewhere = await fetch(`${url}/api/projects`, { headers: { origin: "https://example.com" } });
    assert.equal(elsewhere.status, 403);
    const local = await fetch(`${url}/api/projects`, { headers: { origin: "http://localhost:5173" } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const preflight = await fetch(`${url}/api/projects`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5174" } });
    assert.equal(preflight.status, 204);
    // A hostname that merely resolves here (DNS rebinding) is refused.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(`${url}/api/health`, { headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    assert.equal(status, 403);
    await assert.rejects(a.get("../secrets"), /valid project id|Not found|No project/);
  });
});

describe("tools", () => {
  const manifest = { id: "demo", name: "tako-demo", title: "Demo tool", tagline: "Shows how tools plug in", opens: ["project", "node"], version: "1.2.3" };
  /** A built page, as a tool's release would contain it. */
  function builtPage(m: Record<string, unknown> = manifest) {
    const built = mkdtempSync(join(tmpdir(), "tako-tool-"));
    mkdirSync(join(built, "dist", "assets"), { recursive: true });
    writeFileSync(join(built, "dist", "index.html"), "<!doctype html><title>demo</title>");
    writeFileSync(join(built, "dist", "assets", "app.js"), "console.log('demo')");
    writeFileSync(join(built, "dist", "tako.tool.json"), JSON.stringify(m));
    return built;
  }

  it("installs a built page and serves it, knowing only its manifest", async () => {
    assert.deepEqual(await a.tools(), []);
    const built = builtPage();
    const installed = hubServer.tools.addFromDir(built);
    assert.equal(installed.id, "demo");
    rmSync(built, { recursive: true, force: true });

    const [tool] = await a.tools();
    assert.deepEqual(tool, { ...manifest, url: `${url}/demo/`, dev: false });

    const page = await fetch(`${url}/demo/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(await page.text(), /<title>demo/);
    const js = await fetch(`${url}/demo/assets/app.js`);
    assert.match(js.headers.get("content-type")!, /javascript/);
    const bare = await fetch(`${url}/demo`, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), "/demo/");
  });

  it("never serves a file outside the tool's folder", async () => {
    for (const path of ["/demo/..%2f..%2fa-fresh-idea.tako.json", "/demo/%2e%2e/%2e%2e/a-fresh-idea.tako.json", "/demo//etc/passwd", "/nope/"]) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 404, path);
    }
  });

  it("refuses a page with no manifest, or a bad one", () => {
    const empty = mkdtempSync(join(tmpdir(), "tako-tool-"));
    assert.throws(() => hubServer.tools.addFromDir(empty), /No built tool found/);
    const bad = builtPage({ ...manifest, id: "api" });
    assert.throws(() => hubServer.tools.addFromDir(bad), /isn't valid/);
    rmSync(empty, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  });

  it("builds links that carry only what the tool can open", async () => {
    const [tool] = await a.tools();
    const link = new URL(a.linkTo(tool!, { project: "my-project", node: "n1", work: "w1" }));
    assert.equal(link.pathname, "/demo/");
    assert.equal(link.searchParams.get("project"), "my-project");
    assert.equal(link.searchParams.get("node"), "n1");
    assert.equal(link.searchParams.get("work"), null, "this tool didn't say it opens work items");
    assert.equal(link.searchParams.get("hub"), null, "a tool served by the hub finds it at its own origin");
  });

  it("lists a tool that announces itself, in place of the installed copy", async () => {
    const post = (body: unknown) =>
      fetch(`${url}/api/tools/announce`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ manifest, url: "http://localhost:5173/" })).status, 200);
    const [tool, ...rest] = await a.tools();
    assert.equal(rest.length, 0);
    assert.equal(tool!.url, "http://localhost:5173/");
    assert.equal(tool!.dev, true);
    // Not served by this hub, and the hub isn't at the default address: the link says where the hub is.
    assert.equal(new URL(a.linkTo(tool!, { project: "p" })).searchParams.get("hub"), url);
    assert.equal((await post({ manifest, url: "https://example.com/" })).status, 422, "only localhost tools can announce");
    assert.equal((await post({ manifest: { id: "x" }, url: "http://localhost:1/" })).status, 422);
  });

  it("removes an installed tool", async () => {
    assert.equal(hubServer.tools.remove("demo"), true);
    assert.equal((await fetch(`${url}/demo/`)).status, 404);
    assert.equal(hubServer.tools.remove("demo"), false);
  });

  it("serves a home page", async () => {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>tako<\/title>/);
  });
});

describe("slugify", () => {
  it("makes safe file names", () => {
    assert.equal(slugify("Why is my sourdough flat?"), "why-is-my-sourdough-flat");
    assert.equal(slugify("  ../../etc/passwd "), "etc-passwd");
    assert.equal(slugify("蛸"), "project");
  });
});

describe("local store", () => {
  it("has the same contract without a hub", () => {
    const s = createLocalStore(migrateProject(fixture("bird-feeder.json")));
    const first = s.get();
    const node = first.project.nodes[0]!;
    assert.equal(first.sync, "local");
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.dispatch(rename(node.id, "X"));
    assert.equal(s.get().project.nodes[0]!.title, "X");
    assert.equal(calls, 1);
    for (let i = 1; i <= 5; i++) s.preview([{ type: "move_node", id: node.id, x: node.x + i, y: node.y }]);
    s.commitPreview();
    s.undo();
    assert.equal(s.get().project.nodes[0]!.x, node.x, "the drag is one step");
    assert.equal(s.get().project.nodes[0]!.title, "X");
    s.undo();
    assert.equal(s.get().project, first.project);
    assert.equal(s.get().canRedo, true);
    assert.throws(() => s.dispatch(rename("no-such-node", "Y")));
    off();
  });
});
