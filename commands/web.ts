import { execFile } from "node:child_process";
import { initializeRuntime } from "../lib/runtime-init.js";
import { runWebServer } from "../web/server.js";

initializeRuntime();

function maybeOpenBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(opener, [url], () => {
    // Ignore opener errors; server still runs.
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const hostArgIndex = args.indexOf("--host");
  const portArgIndex = args.indexOf("--port");
  const open = args.includes("--open");

  const host = hostArgIndex >= 0 ? args[hostArgIndex + 1] : "127.0.0.1";
  const portRaw = portArgIndex >= 0 ? args[portArgIndex + 1] : undefined;
  const port = portRaw ? parseInt(portRaw, 10) : 4317;

  if (!host) {
    console.error("--host requires a value");
    process.exit(1);
  }
  if (!Number.isInteger(port) || port <= 0) {
    console.error("--port must be a positive integer");
    process.exit(1);
  }

  const url = `http://${host}:${port}`;
  console.error(`Starting Copse web app at ${url}`);
  if (open) {
    maybeOpenBrowser(url);
  }
  runWebServer({ host, port });
}

main();
