// The hub's HTTP face. Local only: it binds to this machine, answers only
// requests addressed to localhost, and only pages served from localhost may
// read its answers. No accounts, no tool-specific knowledge.
//
//   GET    /api/health
//   GET    /api/projects                 list
//   POST   /api/projects                 { title } | { document, fallbackTitle }
//   GET    /api/projects/:id
//   DELETE /api/projects/:id             (moves the file to .tako/trash)
//   POST   /api/projects/:id/ops         { batches: [{ ops, coalesceKey? }] }
//   POST   /api/projects/:id/undo|redo
//   POST   /api/check-ops                { ops }
//   GET    /api/events                   server-sent events: changes
//   GET    /api/tools                    tools reachable right now
//   POST   /api/tools/announce           { manifest, url } from a running tool
//
// Beside the API it serves pages: `/` is the home page (projects and
// tools), and `/<id>/…` is an installed tool's built page.

import { readFileSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { ZodError } from "zod";
import { SCHEMA_VERSION } from "../project";
import { parseOps } from "../schema";
import type { HubEvent } from "../client";
import { NotFound, ProjectFolder, Rejected, type Batch, type Who } from "./projects";
import { ToolShelf } from "./tools";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};
const HOME = new URL("./home.html", import.meta.url);

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY = 32 * 1024 * 1024;

export type HubOptions = { dir: string; version: string };

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Rejected("That request is too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
        resolve(body as Record<string, unknown>);
      } catch {
        reject(new Rejected("The request body isn't a JSON object."));
      }
    });
    req.on("error", reject);
  });
}

const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 80) : undefined);
const whoOf = (body: Record<string, unknown>): Who => ({
  author: str(body.author),
  via: str(body.via),
  clientId: str(body.clientId),
});

export function createHub({ dir, version }: HubOptions): {
  server: Server;
  folder: ProjectFolder;
  tools: ToolShelf;
  close(): Promise<void>;
} {
  const folder = new ProjectFolder(dir);
  const tools = new ToolShelf(dir);
  const streams = new Set<ServerResponse>();
  const broadcast = (e: HubEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of streams) res.write(line);
  };
  folder.on(broadcast);
  // `tako add` runs as its own process: notice what it installs.
  let toolsWatcher: ReturnType<typeof watch> | null = null;
  try {
    toolsWatcher = watch(tools.dir, () => broadcast({ type: "tools" }));
  } catch {
    // No watching here: the home page still re-reads when it's focused.
  }
  // Keeps idle streams from being dropped by anything in between.
  const beat = setInterval(() => {
    for (const res of streams) res.write(": beat\n\n");
  }, 25_000);
  beat.unref();

  async function route(req: IncomingMessage, res: ServerResponse, send: (status: number, body: unknown) => void) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    if (parts[0] !== "api") {
      if (method !== "GET" && method !== "HEAD") return send(404, { error: "Not found." });
      return page(url.pathname, parts, res, send);
    }
    if (parts[1] === "tools") {
      const hubUrl = `http://${req.headers.host}`;
      if (parts[2] === undefined && method === "GET") return send(200, { tools: tools.list(hubUrl) });
      if (parts[2] === "announce" && method === "POST") {
        const body = await readJson(req);
        try {
          if (tools.announce(body.manifest, body.url)) broadcast({ type: "tools" });
        } catch (e) {
          throw new Rejected(e instanceof ZodError ? "That isn't a valid tool manifest." : e instanceof Error ? e.message : "Couldn't announce that tool.");
        }
        return send(200, { ok: true });
      }
      return send(404, { error: "Not found." });
    }

    if (parts[1] === "health" && method === "GET") {
      return send(200, { name: "tako", version, schemaVersion: SCHEMA_VERSION, dir });
    }
    if (parts[1] === "events" && method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (parts[1] === "check-ops" && method === "POST") {
      const body = await readJson(req);
      try {
        return send(200, { ops: parseOps(body.ops) });
      } catch (e) {
        const first = e instanceof ZodError ? e.issues[0] : undefined;
        const where = first?.path.length ? ` (at ${first.path.join(".")})` : "";
        throw new Rejected(first ? `Not a valid op list: ${first.message}${where}.` : "Not a valid op list.");
      }
    }
    if (parts[1] === "projects") {
      const id = parts[2];
      if (id === undefined) {
        if (method === "GET") return send(200, { projects: folder.list() });
        if (method === "POST") {
          const body = await readJson(req);
          return send(201, folder.create(body, whoOf(body)));
        }
      } else if (parts[3] === undefined) {
        if (method === "GET") return send(200, folder.get(id));
        if (method === "DELETE") {
          folder.remove(id);
          return send(200, { ok: true });
        }
      } else if (method === "POST" && parts[4] === undefined) {
        const body = await readJson(req);
        if (parts[3] === "ops") {
          if (!Array.isArray(body.batches)) throw new Rejected("Expected { batches: [{ ops }] }.");
          return send(200, folder.apply(id, body.batches as Batch[], whoOf(body)));
        }
        if (parts[3] === "undo" || parts[3] === "redo") return send(200, folder.step(id, parts[3], whoOf(body)));
      }
    }
    send(404, { error: "Not found." });
  }

  /** Pages: the home page, and installed tools' files. */
  function page(pathname: string, parts: string[], res: ServerResponse, send: (status: number, body: unknown) => void) {
    const file = (path: string | URL, type: string) => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(readFileSync(path));
    };
    if (parts.length === 0) return file(HOME, TYPES[".html"]!);
    const id = parts[0]!;
    if (!tools.installedDir(id)) return send(404, { error: "Not found." });
    // `/arm` → `/arm/`, so the page's relative asset links resolve.
    if (parts.length === 1 && !pathname.endsWith("/")) {
      res.writeHead(301, { location: `/${id}/` });
      return res.end();
    }
    const found = tools.resolveFile(id, pathname.slice(id.length + 1));
    if (!found) return send(404, { error: "Not found." });
    file(found, TYPES[extname(found).toLowerCase()] ?? "application/octet-stream");
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    // A page elsewhere on the web must not reach this, even through a
    // domain that resolves to this machine: check who was asked, and who asks.
    if (!LOCAL_HOST.test(req.headers.host ?? "")) return send(403, { error: "The hub only answers on localhost." });
    if (origin !== undefined) {
      if (!LOCAL_ORIGIN.test(origin)) return send(403, { error: "The hub only answers pages served from this machine." });
      headers["access-control-allow-origin"] = origin;
      headers.vary = "origin";
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...headers,
        "access-control-allow-methods": "GET, POST, DELETE",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      return res.end();
    }
    if (req.url?.startsWith("/api/events")) {
      // The stream writes its own head; it still needs the CORS answer.
      if (origin) res.setHeader("access-control-allow-origin", origin);
    }
    route(req, res, send).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof NotFound) send(404, { error: e.message });
      else if (e instanceof Rejected) send(422, { error: e.message, doc: e.doc });
      else {
        console.error(e);
        send(500, { error: "The hub hit an unexpected error; see its terminal." });
      }
    });
  });

  return {
    server,
    folder,
    tools,
    close: () =>
      new Promise((resolve) => {
        clearInterval(beat);
        toolsWatcher?.close();
        folder.close();
        for (const res of streams) res.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
