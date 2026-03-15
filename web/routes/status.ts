import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../../lib/config.js";
import { fetchPRsWithStatus } from "../../lib/services/status-service.js";
import { WATCH_INTERVAL_MS } from "../../lib/services/status-types.js";
import { loadTemplates, resolveTemplatesPath } from "../../lib/templates.js";
import {
  sendJson,
  parseStatusFilterScope,
  resolveReposFromRequest,
} from "./helpers.js";

export async function handleStatusRoutes(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
  const method = req.method || "GET";

  if (method === "GET" && url.pathname === "/api/templates") {
    const config = loadConfig() ?? {};
    const templatesPath = resolveTemplatesPath(null, (config as Record<string, string>).commentTemplates ?? null);
    const templates = loadTemplates(templatesPath);
    const result: Array<{ label: string; body: string }> = [];
    for (const [label, body] of templates) {
      result.push({ label, body });
    }
    sendJson(res, 200, { templates: result });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/status") {
    const scope = parseStatusFilterScope(url);
    const repos = resolveReposFromRequest(url);
    const rows = await fetchPRsWithStatus({ repos, scope });
    sendJson(res, 200, {
      repos,
      scope,
      pollIntervalMs: WATCH_INTERVAL_MS,
      rows,
      cursorApiConfigured: Boolean(loadConfig()?.cursorApiKey?.trim()),
    });
    return true;
  }

  return false;
}
