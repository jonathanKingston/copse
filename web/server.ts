import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getConfiguredRepos, loadConfig } from "../lib/config.js";
import { REPO_PATTERN, listPRReviewCommentsAsync, validateRepo } from "../lib/gh.js";
import { getOriginRepo } from "../lib/utils.js";
import { fetchPRsWithStatus } from "../lib/services/status-service.js";
import {
  approvePullRequest,
  createIssueWithAgentComment,
  enableMergeWhenReady,
  mergeBaseIntoBranch,
  postPullRequestComment,
  postPullRequestReply,
  rerunFailedWorkflowRuns,
} from "../lib/services/status-actions.js";
import { WATCH_INTERVAL_MS } from "../lib/services/status-types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const PUBLIC_DIR = resolve(fileURLToPath(new URL("./public", import.meta.url)));

interface WebServerOptions {
  host?: string;
  port?: number;
}

interface JsonMap {
  [key: string]: unknown;
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonMap): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<JsonMap> {
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

function getMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function parseRepoList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveReposFromRequest(url: URL): string[] {
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

function parsePathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function parsePrTarget(segments: string[]): { repo: string; prNumber: number; action: string } | null {
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

async function handleApi(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  const method = req.method || "GET";
  const segments = parsePathSegments(url);

  if (method === "GET" && url.pathname === "/api/status") {
    const mineOnly = url.searchParams.get("mineOnly") !== "false";
    const repos = resolveReposFromRequest(url);
    const rows = await fetchPRsWithStatus({ repos, mineOnly });
    sendJson(res, 200, {
      repos,
      mineOnly,
      pollIntervalMs: WATCH_INTERVAL_MS,
      rows,
      cursorApiConfigured: Boolean(loadConfig()?.cursorApiKey?.trim()),
    });
    return;
  }

  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "comments") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }
    const comments = await listPRReviewCommentsAsync(repo, prNumber);
    sendJson(res, 200, { repo, prNumber, comments });
    return;
  }

  if (method === "POST" && url.pathname === "/api/issues") {
    const body = await readJsonBody(req);
    const repo = String(body.repo || "");
    const title = String(body.title || "");
    const issueBody = String(body.body || "");
    const agent = String(body.agent || "cursor");
    const templateChoice = Number(body.templateChoice);
    if (![0, 1, 2, 3].includes(templateChoice)) {
      throw new Error("templateChoice must be one of: 0, 1, 2, 3");
    }
    const result = await createIssueWithAgentComment({
      repo,
      title,
      body: issueBody,
      agent,
      templateChoice: templateChoice as 0 | 1 | 2 | 3,
    });
    sendJson(res, 200, {
      ok: true,
      issueNumber: result.issueNumber,
      commentAdded: result.commentAdded,
      message: result.commentAdded
        ? `Created issue #${result.issueNumber} with comment`
        : `Created issue #${result.issueNumber}`,
    });
    return;
  }

  const target = parsePrTarget(segments);
  if (method === "POST" && target) {
    const body = await readJsonBody(req);
    if (target.action === "rerun") {
      const result = await rerunFailedWorkflowRuns(target.repo, String(body.headRefName || ""));
      sendJson(res, 200, { ok: true, total: result.total, message: `Reran ${result.total} workflow(s)` });
      return;
    }
    if (target.action === "update-main") {
      const headRefName = String(body.headRefName || "");
      const result = await mergeBaseIntoBranch(target.repo, headRefName, "main");
      sendJson(res, 200, {
        ok: true,
        alreadyUpToDate: result.alreadyUpToDate,
        message: result.alreadyUpToDate ? "Already up to date with main" : "Merged main into branch",
      });
      return;
    }
    if (target.action === "approve") {
      await approvePullRequest(target.repo, target.prNumber);
      sendJson(res, 200, { ok: true, message: "Approved PR" });
      return;
    }
    if (target.action === "merge-auto") {
      await enableMergeWhenReady(target.repo, target.prNumber);
      sendJson(res, 200, { ok: true, message: "Merge when ready enabled" });
      return;
    }
    if (target.action === "comment") {
      const text = String(body.body || "");
      await postPullRequestComment(target.repo, target.prNumber, text);
      sendJson(res, 200, { ok: true, message: "Comment posted" });
      return;
    }
    if (target.action === "reply") {
      const text = String(body.body || "");
      const inReplyToId = Number(body.inReplyToId);
      if (!Number.isInteger(inReplyToId) || inReplyToId <= 0) {
        throw new Error("inReplyToId must be a positive number");
      }
      const cursorApiKey = loadConfig()?.cursorApiKey?.trim() || null;
      const result = await postPullRequestReply({
        repo: target.repo,
        prNumber: target.prNumber,
        inReplyToId,
        body: text,
        cursorApiKey,
      });
      sendJson(res, 200, { ok: true, mode: result.mode, message: "Reply posted" });
      return;
    }
  }

  sendJson(res, 404, { error: "Endpoint not found" });
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
        await handleApi(req, url, res);
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
