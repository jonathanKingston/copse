import type { IncomingMessage, ServerResponse } from "node:http";
import { REPO_PATTERN, validateRepo } from "../../lib/gh.js";
import { getOriginRepo } from "../../lib/utils.js";
import { getConfiguredRepos, loadConfig } from "../../lib/config.js";
import {
  STATUS_FILTER_SCOPES,
  type StatusFilterScope,
} from "../../lib/services/status-types.js";

export interface JsonMap {
  [key: string]: unknown;
}

export function sendJson(res: ServerResponse, statusCode: number, body: JsonMap): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export async function readJsonBody(req: IncomingMessage): Promise<JsonMap> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object");
    }
    return parsed as JsonMap;
  } catch (error: unknown) {
    throw new Error(`invalid JSON body: ${(error as Error).message}`);
  }
}

export function parseRepoList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveReposFromRequest(url: URL): string[] {
  const reposFromQuery = parseRepoList(url.searchParams.get("repos"));
  if (reposFromQuery.length > 0) {
    for (const repo of reposFromQuery) {
      validateRepo(repo);
    }
    return reposFromQuery;
  }

  const originRepo = getOriginRepo();
  if (originRepo) {
    return [originRepo];
  }

  const configured = getConfiguredRepos();
  if (configured && configured.length > 0) {
    return configured;
  }

  throw new Error("No repos configured. Run `copse init` or pass repos in query string.");
}

export function parsePathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

export function parseStatusFilterScope(url: URL): StatusFilterScope {
  const scope = url.searchParams.get("scope");
  if (scope == null || scope === "") {
    if (url.searchParams.get("mineOnly") === "false") {
      return "all";
    }
    return "my-stacks";
  }
  if ((STATUS_FILTER_SCOPES as readonly string[]).includes(scope)) {
    return scope as StatusFilterScope;
  }
  throw new Error(`Invalid scope: "${scope}"`);
}

export function parsePrTarget(segments: string[]): { repo: string; prNumber: number; action: string } | null {
  if (segments.length !== 5) {
    return null;
  }
  if (segments[0] !== "api" || segments[1] !== "pr") {
    return null;
  }
  const [_, __, repo, prNumberRaw, action] = segments;
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repo: "${repo}"`);
  }
  const prNumber = parseInt(prNumberRaw, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid pull request number: "${prNumberRaw}"`);
  }
  return { repo, prNumber, action };
}

export function parseReplyDelivery(value: unknown): "github" | "cursor" {
  if (value == null || value === "") {
    return "github";
  }
  if (value === "github" || value === "cursor") {
    return value;
  }
  throw new Error('delivery must be either "github" or "cursor"');
}

export function requireCursorApiKey(): string {
  const apiKey = loadConfig()?.cursorApiKey?.trim() || "";
  if (!apiKey) {
    throw new Error('Cursor API not configured. Set "cursorApiKey" in .copserc.');
  }
  return apiKey;
}
