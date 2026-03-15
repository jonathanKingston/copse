import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getConfiguredRepos, loadConfig } from "../lib/config.js";
import { REPO_PATTERN, listPRReviewCommentsAsync, listPRFilesAsync, validateRepo } from "../lib/gh.js";
import { getOriginRepo } from "../lib/utils.js";
import { fetchPRsWithStatus } from "../lib/services/status-service.js";
import {
  approvePullRequest,
  chainMergePRs,
  createPullRequestForBranch,
  createIssueWithAgentComment,
  enableMergeWhenReady,
  markPullRequestReady,
  mergeBaseIntoBranch,
  postPullRequestComment,
  postPullRequestReply,
  retargetPullRequest,
  rerunFailedWorkflowRuns,
} from "../lib/services/status-actions.js";
import {
  STATUS_FILTER_SCOPES,
  WATCH_INTERVAL_MS,
  type StatusFilterScope,
} from "../lib/services/status-types.js";
import { findLatestAgentByPrUrl, getArtifactDownloadUrl, listAgentArtifacts, listAgentsByPrUrl } from "../lib/cursor-api.js";
import { sendReplyViaCursorApi } from "../lib/cursor-replies.js";
import { loadTemplates, resolveTemplatesPath } from "../lib/templates.js";

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

function parseStatusFilterScope(url: URL): StatusFilterScope {
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

function parseReplyDelivery(value: unknown): "github" | "cursor" {
  if (value == null || value === "") {
    return "github";
  }
  if (value === "github" || value === "cursor") {
    return value;
  }
  throw new Error('delivery must be either "github" or "cursor"');
}

function formatCommentLocation(comment: { path: string; line: number | null; original_line: number | null }): string {
  return `${comment.path}:${comment.line ?? comment.original_line ?? "?"}`;
}

function buildCursorCommentReplyPrompt(
  comments: Array<{ body: string; path: string; line: number | null; original_line: number | null; user: { login: string } }>,
  replyText: string
): string {
  const commentSummary = comments.map((comment, index) => [
    `${index + 1}. ${comment.user.login} on ${formatCommentLocation(comment)}`,
    String(comment.body || "").trim(),
  ].join("\n")).join("\n\n");

  return [
    "Please address these selected PR review comments.",
    "",
    commentSummary,
    "",
    "Use this reply/instruction:",
    replyText.trim(),
  ].join("\n");
}

function requireCursorApiKey(): string {
  const apiKey = loadConfig()?.cursorApiKey?.trim() || "";
  if (!apiKey) {
    throw new Error('Cursor API not configured. Set "cursorApiKey" in .copserc.');
  }
  return apiKey;
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

  if (method === "GET" && url.pathname === "/api/templates") {
    const config = loadConfig() ?? {};
    const templatesPath = resolveTemplatesPath(null, (config as Record<string, string>).commentTemplates ?? null);
    const templates = loadTemplates(templatesPath);
    const result: Array<{ label: string; body: string }> = [];
    for (const [label, body] of templates) {
      result.push({ label, body });
    }
    sendJson(res, 200, { templates: result });
    return;
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
    return;
  }

  // Cursor artifacts for a PR (latest Cursor agent by PR URL).
  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "artifacts") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }

    const cursorApiKey = requireCursorApiKey();
    const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    const requestedAgentId = url.searchParams.get("agentId") || null;

    let agentId: string | null = null;
    if (requestedAgentId) {
      const agents = await listAgentsByPrUrl(cursorApiKey, prUrl);
      const match = agents.find((a) => a.id === requestedAgentId) ?? null;
      if (!match) {
        throw new Error("Unknown agentId for this PR");
      }
      agentId = match.id;
    } else {
      const agent = await findLatestAgentByPrUrl(cursorApiKey, prUrl);
      agentId = agent?.id ?? null;
    }

    if (!agentId) {
      sendJson(res, 200, { repo, prNumber, prUrl, agentId: null, artifacts: [] });
      return;
    }

    const artifacts = await listAgentArtifacts(cursorApiKey, agentId);
    sendJson(res, 200, { repo, prNumber, prUrl, agentId, artifacts });
    return;
  }

  // Cursor agents previously run for a PR (by PR URL).
  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "agents") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }
    const cursorApiKey = requireCursorApiKey();
    const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    const agents = await listAgentsByPrUrl(cursorApiKey, prUrl);
    sendJson(res, 200, { repo, prNumber, prUrl, agents });
    return;
  }

  // Redirect to presigned download URL (keeps Cursor API key server-side).
  if (
    method === "GET" &&
    segments.length === 6 &&
    segments[0] === "api" &&
    segments[1] === "cursor" &&
    segments[2] === "agents" &&
    segments[4] === "artifacts" &&
    segments[5] === "download"
  ) {
    const agentId = segments[3];
    const absolutePath = url.searchParams.get("path") || "";
    if (!absolutePath) {
      throw new Error('Missing required query param "path"');
    }
    const cursorApiKey = requireCursorApiKey();
    const { url: downloadUrl } = await getArtifactDownloadUrl(cursorApiKey, agentId, absolutePath);
    res.writeHead(302, {
      location: downloadUrl,
      "cache-control": "no-store",
    });
    res.end();
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

  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "files") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }
    const files = await listPRFilesAsync(repo, prNumber);
    sendJson(res, 200, { repo, prNumber, files });
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
    const targetPr = body.pr ? Number(body.pr) : null;
    if (targetPr !== null && (!Number.isInteger(targetPr) || targetPr <= 0)) {
      throw new Error("pr must be a valid pull request number");
    }
    const cursorApiKey = loadConfig()?.cursorApiKey?.trim() || null;
    const result = await createIssueWithAgentComment({
      repo,
      title,
      body: issueBody,
      agent,
      templateChoice: templateChoice as 0 | 1 | 2 | 3,
      cursorApiKey,
      targetPr,
    });
    sendJson(res, 200, {
      ok: true,
      issueNumber: result.issueNumber,
      commentAdded: result.commentAdded,
      cursorAgentLaunched: result.cursorAgentLaunched,
      targetPr: targetPr ?? undefined,
      message: result.cursorAgentLaunched
        ? targetPr
          ? `Created issue #${result.issueNumber}, Cursor agent targeting PR #${targetPr}`
          : `Created issue #${result.issueNumber}, Cursor agent launched`
        : result.commentAdded
          ? `Created issue #${result.issueNumber} with comment`
          : `Created issue #${result.issueNumber}`,
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/chain-merge") {
    const body = await readJsonBody(req);
    const repo = String(body.repo || "");
    validateRepo(repo);
    const prs = body.prs as Array<{ number: number; headRefName: string }> | undefined;
    if (!Array.isArray(prs) || prs.length < 2) {
      throw new Error("prs must be an array of at least 2 items with number and headRefName");
    }
    for (const pr of prs) {
      if (!Number.isInteger(pr.number) || pr.number <= 0 || typeof pr.headRefName !== "string") {
        throw new Error("Each PR must have a valid number and headRefName");
      }
    }
    const result = await chainMergePRs(repo, prs);
    sendJson(res, 200, {
      ok: true,
      steps: result.steps,
      stoppedEarly: result.stoppedEarly,
      message: result.stoppedEarly
        ? `Stack queue stopped early after ${result.steps.length} step(s)`
        : `Stack queued: ${result.steps.length} step(s)`,
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/branches/create-pr") {
    const body = await readJsonBody(req);
    const repo = String(body.repo || "");
    const headRefName = String(body.headRefName || "");
    validateRepo(repo);
    if (!headRefName.trim()) {
      throw new Error("headRefName cannot be empty");
    }
    const result = await createPullRequestForBranch(repo, headRefName);
    sendJson(res, 200, {
      ok: true,
      repo,
      headRefName,
      baseBranch: result.baseBranch,
      title: result.title,
      url: result.url,
      message: `Created PR for ${headRefName} into ${result.baseBranch}`,
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
    if (target.action === "ready") {
      const result = await markPullRequestReady(target.repo, target.prNumber);
      sendJson(res, 200, {
        ok: true,
        alreadyReady: result.alreadyReady,
        message: result.alreadyReady ? "PR already ready for review" : "Marked PR ready for review",
      });
      return;
    }
    if (target.action === "retarget") {
      const baseBranch = String(body.baseBranch || "");
      const result = await retargetPullRequest(target.repo, target.prNumber, baseBranch);
      sendJson(res, 200, {
        ok: true,
        closedRedundant: result.closedRedundant,
        alreadyTargeted: result.alreadyTargeted,
        message: result.closedRedundant
          ? `Closed PR after finding no commits unique beyond ${baseBranch}`
          : result.alreadyTargeted
            ? `PR already targets ${baseBranch}`
          : `Retargeted PR to ${baseBranch}`,
      });
      return;
    }
    if (target.action === "merge-auto") {
      const result = await enableMergeWhenReady(target.repo, target.prNumber);
      sendJson(res, 200, {
        ok: true,
        alreadyEnabled: result.alreadyEnabled,
        message: result.alreadyEnabled ? "Merge when ready already enabled" : "Merge when ready enabled",
      });
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
      const delivery = parseReplyDelivery(body.delivery);
      let result: { mode: "github" | "cursor-followup" | "cursor-launch" };
      if (delivery === "cursor") {
        const cursorApiKey = requireCursorApiKey();
        const comments = await listPRReviewCommentsAsync(target.repo, target.prNumber);
        const selectedComment = comments.find((comment) => comment.id === inReplyToId);
        if (!selectedComment) {
          throw new Error(`Could not load selected comment ${inReplyToId}`);
        }
        const cursorResult = await sendReplyViaCursorApi({
          repo: target.repo,
          prNumber: target.prNumber,
          replyText: buildCursorCommentReplyPrompt([selectedComment], text),
          cursorApiKey,
        });
        result = { mode: cursorResult.mode === "followup" ? "cursor-followup" : "cursor-launch" };
      } else {
        result = await postPullRequestReply({
          repo: target.repo,
          prNumber: target.prNumber,
          inReplyToId,
          body: text,
        });
      }
      sendJson(res, 200, {
        ok: true,
        mode: result.mode,
        message: result.mode === "cursor-followup"
          ? "Reply sent to Cursor agent"
          : result.mode === "cursor-launch"
            ? "No linked agent found, so a new Cursor agent was launched"
            : "Reply posted in GitHub thread",
      });
      return;
    }
    if (target.action === "batch-reply") {
      const text = String(body.body || "");
      const commentIds = body.commentIds;
      if (!Array.isArray(commentIds) || commentIds.length === 0) {
        throw new Error("commentIds must be a non-empty array");
      }
      const delivery = parseReplyDelivery(body.delivery);
      const numericCommentIds = commentIds.map((id) => {
        const inReplyToId = Number(id);
        if (!Number.isInteger(inReplyToId) || inReplyToId <= 0) {
          throw new Error("commentIds must contain only positive numbers");
        }
        return inReplyToId;
      });

      if (delivery === "cursor") {
        const cursorApiKey = requireCursorApiKey();
        const comments = await listPRReviewCommentsAsync(target.repo, target.prNumber);
        const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
        const selectedComments = numericCommentIds.map((id) => {
          const comment = commentsById.get(id);
          if (!comment) {
            throw new Error(`Could not load selected comment ${id}`);
          }
          return comment;
        });
        const result = await sendReplyViaCursorApi({
          repo: target.repo,
          prNumber: target.prNumber,
          replyText: buildCursorCommentReplyPrompt(selectedComments, text),
          cursorApiKey,
        });
        sendJson(res, 200, {
          ok: true,
          total: selectedComments.length,
          mode: result.mode === "followup" ? "cursor-followup" : "cursor-launch",
          message: result.mode === "followup"
            ? `Sent Cursor follow-up with ${selectedComments.length} selected comment(s)`
            : `Launched Cursor agent with ${selectedComments.length} selected comment(s)`,
        });
        return;
      }

      let succeeded = 0;
      for (const inReplyToId of numericCommentIds) {
        await postPullRequestReply({
          repo: target.repo,
          prNumber: target.prNumber,
          inReplyToId,
          body: text,
        });
        succeeded++;
      }
      sendJson(res, 200, { ok: true, total: succeeded, message: `Replied to ${succeeded} comment(s)` });
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
