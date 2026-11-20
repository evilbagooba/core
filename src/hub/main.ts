// `tako`: the hub, and the tools it serves.
//
//   tako [--dir <folder>] [--port <n>]     start the hub
//   tako add <owner/repo | folder>         install a tool
//   tako remove <id>                       uninstall a tool
//   tako tools                             list installed tools
//
// Defaults: ~/tako and port 4100 (or $TAKO_DIR / $TAKO_PORT).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createHub } from "./server";
import { ToolShelf } from "./tools";

const HELP = `tako [--dir <folder>] [--port <n>]   start the hub
tako add <owner/repo | folder>       install a tool: the latest GitHub release
                                     of a repo, or a built page in a folder
tako remove <id>                     uninstall a tool
tako tools                           list installed tools

The hub keeps projects as .tako.json files in the folder (default ~/tako),
serves them to the tools on localhost (default port 4100), and serves the
installed tools themselves at http://localhost:<port>/<id>/.`;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const words = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const dir = resolve(flag("dir") ?? process.env.TAKO_DIR ?? join(homedir(), "tako"));
const port = Number(flag("port") ?? process.env.TAKO_PORT ?? 4100);
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const [command, arg] = words;

async function main() {
  if (command === "add") {
    if (!arg) throw new Error("tako add <owner/repo | folder>");
    const shelf = new ToolShelf(dir);
    // A folder that exists wins; otherwise owner/repo means GitHub.
    const tool = existsSync(arg) ? shelf.addFromDir(arg) : /^[\w.-]+\/[\w.-]+$/.test(arg) ? await shelf.addFromGitHub(arg) : null;
    if (!tool) throw new Error(`"${arg}" is neither a folder nor an owner/repo.`);
    console.log(`Installed ${tool.name}${tool.version ? ` ${tool.version}` : ""} (${tool.title})\n  http://localhost:${port}/${tool.id}/`);
    return;
  }
  if (command === "remove") {
    if (!arg) throw new Error("tako remove <id>");
    console.log(new ToolShelf(dir).remove(arg) ? `Removed ${arg}.` : `No tool "${arg}" is installed.`);
    return;
  }
  if (command === "tools") {
    const list = new ToolShelf(dir).list(`http://localhost:${port}`);
    console.log(list.length ? list.map((t) => `${t.id.padEnd(10)} ${t.name}${t.version ? ` ${t.version}` : ""}  ${t.title}`).join("\n") : "No tools installed. Try: tako add evilbagooba/tako-nerve");
    return;
  }
  if (command !== undefined) throw new Error(`Unknown command "${command}".\n\n${HELP}`);

  const hub = createHub({ dir, version });
  hub.server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Is the hub already running?` : e.message);
    process.exit(1);
  });
  hub.server.listen(port, "127.0.0.1", () => {
    const n = hub.folder.list().length;
    const tools = hub.tools.list(`http://localhost:${port}`);
    console.log(
      [
        `tako ${version}`,
        `  projects  ${dir}  (${n} project${n === 1 ? "" : "s"})`,
        `  home      http://localhost:${port}/`,
        ...tools.map((t) => `  ${t.id.padEnd(9)} http://localhost:${port}/${t.id}/  ${t.title}`),
        ...(tools.length ? [] : ["  no tools installed yet: tako add evilbagooba/tako-nerve"]),
      ].join("\n"),
    );
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void hub.close().then(() => process.exit(0)));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
