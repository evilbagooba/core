// Tools the hub knows about. The hub has no knowledge of any particular
// tool: each one describes itself in a small manifest (`tako.tool.json`,
// shipped at the root of its built page), and that is all the hub reads.
//
// Two ways a tool is known:
// - installed: its built page was copied into `<dir>/tools/<id>/` by
//   `tako add`, and the hub serves it at `/<id>/`;
// - announced: a tool running somewhere else on this machine (a dev server)
//   told the hub its address. Announcements lapse unless renewed.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ToolInfo, ToolManifest } from "../client";

export const MANIFEST = "tako.tool.json";
/** The release asset `tako add <owner>/<repo>` looks for: the built page,
 * gzipped, with the manifest at its root. */
export const RELEASE_ASSET = "tako-tool.tgz";
const RESERVED = new Set(["api", "tools", "assets", "static"]);
const ANNOUNCE_TTL_MS = 75_000;

export const manifestSchema = z.object({
  /** Short, URL-safe: the tool is served at `/<id>/`. */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).refine((id) => !RESERVED.has(id), { message: "That id is reserved." }),
  name: z.string().min(1).max(60),
  /** What it is, in a word or two: "Work board". */
  title: z.string().min(1).max(60),
  tagline: z.string().max(160).default(""),
  /** What a link can point it at, beyond a project. */
  opens: z.array(z.enum(["project", "node", "work"])).default(["project"]),
  version: z.string().max(40).default(""),
});

export function readManifest(dir: string): ToolManifest {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) throw new Error(`No ${MANIFEST} in ${dir}: this isn't a built tako tool.`);
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${MANIFEST} isn't valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}`);
  return parsed.data;
}

export class ToolShelf {
  readonly dir: string;
  private announced = new Map<string, { manifest: ToolManifest; url: string; at: number }>();

  constructor(root: string) {
    this.dir = join(root, "tools");
    mkdirSync(this.dir, { recursive: true });
  }

  /** The folder an installed tool is served from, or null. */
  installedDir(id: string): string | null {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return null;
    const dir = join(this.dir, id);
    return existsSync(join(dir, MANIFEST)) ? dir : null;
  }

  private installed(): ToolManifest[] {
    const out: ToolManifest[] = [];
    for (const id of readdirSync(this.dir).sort()) {
      try {
        if (this.installedDir(id)) out.push(readManifest(join(this.dir, id)));
      } catch {
        // A broken install is left alone and left out.
      }
    }
    return out;
  }

  /** Every tool reachable right now. An announced tool (one being worked
   * on) takes the place of an installed one with the same id. */
  list(hubUrl: string): ToolInfo[] {
    const now = Date.now();
    for (const [id, a] of this.announced) if (now - a.at > ANNOUNCE_TTL_MS) this.announced.delete(id);
    const tools = new Map<string, ToolInfo>();
    for (const m of this.installed()) tools.set(m.id, { ...m, url: `${hubUrl}/${m.id}/`, dev: false });
    for (const [id, a] of this.announced) tools.set(id, { ...a.manifest, url: a.url, dev: true });
    return [...tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** A running tool says where it is. Returns true if that's news. */
  announce(manifest: unknown, url: unknown): boolean {
    const m = manifestSchema.parse(manifest);
    if (typeof url !== "string" || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url)) {
      throw new Error("A tool can only be announced at a localhost address.");
    }
    const before = this.announced.get(m.id);
    this.announced.set(m.id, { manifest: m, url, at: Date.now() });
    return !before || before.url !== url;
  }

  /** Install a built page from a folder (the folder itself, or its `dist`
   * or `client/dist`). Replaces any earlier install of the same tool. */
  addFromDir(path: string): ToolManifest {
    const base = resolve(path);
    const from = [base, join(base, "dist"), join(base, "client", "dist")].find((d) => existsSync(join(d, MANIFEST)));
    if (!from) throw new Error(`No built tool found in ${base} (looked for ${MANIFEST} there, in dist/ and in client/dist/). Build it first.`);
    const manifest = readManifest(from);
    const to = join(this.dir, manifest.id);
    const staging = `${to}.incoming`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(from, staging, { recursive: true });
    rmSync(to, { recursive: true, force: true });
    renameSync(staging, to);
    return manifest;
  }

  /** Install the latest release of a GitHub repo: its `tako-tool.tgz`. */
  async addFromGitHub(repo: string): Promise<ToolManifest> {
    const api = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetch(api, { headers: { accept: "application/vnd.github+json", "user-agent": "tako" } });
    if (res.status === 404) throw new Error(`${repo} has no releases (or doesn't exist).`);
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}.`);
    const release = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
    const asset = release.assets?.find((a) => a.name === RELEASE_ASSET);
    if (!asset) throw new Error(`The latest release of ${repo} (${release.tag_name ?? "?"}) has no ${RELEASE_ASSET}: it isn't packaged as a tako tool.`);
    const download = await fetch(asset.browser_download_url, { headers: { "user-agent": "tako" } });
    if (!download.ok) throw new Error(`Couldn't download ${asset.name} (${download.status}).`);
    const work = mkdtempSync(join(tmpdir(), "tako-add-"));
    try {
      const archive = join(work, RELEASE_ASSET);
      writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
      const out = join(work, "page");
      mkdirSync(out);
      execFileSync("tar", ["-xzf", archive, "-C", out, "--no-same-owner"], { stdio: "pipe" });
      const manifest = this.addFromDir(out);
      return { ...manifest, version: manifest.version || (release.tag_name ?? "") };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  remove(id: string): boolean {
    const dir = this.installedDir(id);
    if (!dir) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** A file inside an installed tool, or null. Never outside its folder. */
  resolveFile(id: string, rest: string): string | null {
    const root = this.installedDir(id);
    if (!root) return null;
    const file = resolve(root, `.${rest.startsWith("/") ? rest : `/${rest}`}`);
    if (file !== root && !file.startsWith(root + "/")) return null;
    try {
      const s = statSync(file);
      if (s.isDirectory()) return existsSync(join(file, "index.html")) ? join(file, "index.html") : null;
      return file;
    } catch {
      return null;
    }
  }
}
