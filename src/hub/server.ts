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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { SCHEMA_VERSION } from "../project";
import { parseOps } from "../schema";
import { NotFound, ProjectFolder, Rejected, type Batch, type Who } from "./projects";

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

export function createHub({ dir, version }: HubOptions): { server: Server; folder: ProjectFolder; close(): Promise<void> } {
  const folder = new ProjectFolder(dir);
  const streams = new Set<ServerResponse>();
  folder.on((e) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of streams) res.write(line);
  });
  // Keeps idle streams from being dropped by anything in between.
  const beat = setInterval(() => {
    for (const res of streams) res.write(": beat\n\n");
  }, 25_000);
  beat.unref();

  async function route(req: IncomingMessage, res: ServerResponse, send: (status: number, body: unknown) => void) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    if (parts[0] !== "api") return send(404, { error: "Not found." });

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
    close: () =>
      new Promise((resolve) => {
        clearInterval(beat);
        folder.close();
        for (const res of streams) res.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
