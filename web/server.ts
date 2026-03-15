import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeRuntime } from "../lib/runtime-init.js";
import { sendJson, sendText } from "./routes/helpers.js";
import { handleStatusRoutes } from "./routes/status.js";
import { handleCommentRoutes } from "./routes/comments.js";
import { handleActionRoutes } from "./routes/actions.js";
import { handleCursorRoutes } from "./routes/cursor.js";

initializeRuntime();

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const PUBLIC_DIR = resolve(fileURLToPath(new URL("./public", import.meta.url)));

interface WebServerOptions {
  host?: string;
  port?: number;
}

function getMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(url: URL, res: ServerResponse): Promise<void> {
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const absolutePath = resolve(join(PUBLIC_DIR, path));
  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const content = await readFile(absolutePath);
    res.writeHead(200, { "content-type": getMimeType(absolutePath) });
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

export function startWebServer(options: WebServerOptions = {}): ReturnType<typeof createServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  const server = createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing URL" });
      return;
    }
    const url = new URL(req.url, `http://${host}:${port}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        const handled =
          await handleStatusRoutes(req, url, res) ||
          await handleCursorRoutes(req, url, res) ||
          await handleCommentRoutes(req, url, res) ||
          await handleActionRoutes(req, url, res);

        if (!handled) {
          sendJson(res, 404, { error: "Endpoint not found" });
        }
      } else {
        await serveStatic(url, res);
      }
    } catch (error: unknown) {
      sendJson(res, 400, { error: (error as Error).message });
    }
  });

  server.listen(port, host);
  return server;
}

export function runWebServer(options: WebServerOptions = {}): void {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = startWebServer({ host, port });
  const url = `http://${host}:${port}`;
  console.error(`copse web running at ${url}`);
  server.on("error", (error: Error) => {
    console.error(`Failed to start web server: ${error.message}`);
    process.exit(1);
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const portFromEnv = process.env.COPSE_WEB_PORT ? parseInt(process.env.COPSE_WEB_PORT, 10) : undefined;
  runWebServer({ port: Number.isInteger(portFromEnv) ? portFromEnv : undefined });
}
