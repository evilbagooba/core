// `tako`: start the hub.
//
//   tako [--dir <folder>] [--port <n>]
//
// Defaults: ~/tako and port 4100 (or $TAKO_DIR / $TAKO_PORT).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHub } from "./server";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("tako [--dir <folder>] [--port <n>]\n\nStarts the hub: keeps projects as .tako.json files in the folder\n(default ~/tako) and serves them to the tools on localhost (default port 4100).");
  process.exit(0);
}

const dir = resolve(flag("dir") ?? process.env.TAKO_DIR ?? join(homedir(), "tako"));
const port = Number(flag("port") ?? process.env.TAKO_PORT ?? 4100);
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

const hub = createHub({ dir, version });
hub.server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Is the hub already running?` : e.message);
  process.exit(1);
});
hub.server.listen(port, "127.0.0.1", () => {
  const n = hub.folder.list().length;
  console.log(`tako ${version}\n  projects  ${dir}  (${n} project${n === 1 ? "" : "s"})\n  hub       http://localhost:${port}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void hub.close().then(() => process.exit(0)));
