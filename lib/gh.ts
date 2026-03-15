import { execFileSync, execFile } from "child_process";
import type { PR, AgentPatternWithLabels, ExecError, WorkflowRun, PRReviewComment, PRChangedFile } from "./types.js";
import { WATCH_INTERVAL_MS } from "./services/status-types.js";
import { getApiProvider } from "./api-provider.js";
import { ensureMockProviderConfigured } from "./mock-mode.js";

export const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function validateRepo(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repo: "${repo}". Use owner/name format (e.g. acme/cool-project)`);
  }
}

export function validateAgent(agent: string): string {
  const agentLower = agent.toLowerCase();
  if (!["cursor", "claude", "copilot"].includes(agentLower)) {
    throw new Error(`agent must be "cursor", "claude", or "copilot", got "${agent}"`);
  }
  return agentLower;
}

const GH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;
const GRAPHQL_CHUNK_SIZE = 20;
// Scan a generous commit window so agent co-author matches survive follow-up human commits.
const COAUTHOR_SCAN_COMMIT_COUNT = 100;

let _interrupted = false;
let _pipeStdio = false;

ensureMockProviderConfigured();

function activeProvider() {
  ensureMockProviderConfigured();
  return getApiProvider();
}

type CacheDecision = { ok: true; key: string; ttlMs: number } | { ok: false };

const GH_READ_CACHE_MAX_ENTRIES = 500;
const ghReadCache = new Map<string, { expiresAt: number; value: string }>();

function maybePruneGhReadCache(now: number): void {
  // Opportunistic prune: remove expired entries and cap size.
  for (const [k, v] of ghReadCache) {
    if (v.expiresAt <= now) ghReadCache.delete(k);
  }
  if (ghReadCache.size > GH_READ_CACHE_MAX_ENTRIES) {
    ghReadCache.clear();
  }
}

function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const v = args[idx + 1];
  return typeof v === "string" ? v : null;
}

function hasArg(args: string[], value: string): boolean {
  return args.includes(value);
}

function getApiMethod(args: string[]): string {
  const method = (getFlagValue(args, "--method") || getFlagValue(args, "-X") || "").trim();
  return method ? method.toUpperCase() : "GET";
}

function getGraphqlQuery(args: string[]): string | null {
  // We pass GraphQL queries like: -f query=... (or -f `query=${query}`)
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-f") continue;
    const next = args[i + 1] || "";
    if (next.startsWith("query=")) return next.slice("query=".length);
  }
  return null;
}

function isGraphqlMutation(query: string): boolean {
  // Best-effort: treat any query containing "mutation" as non-cacheable.
  // This is conservative and avoids caching stateful operations.
  return /\bmutation\b/i.test(query);
}

function cacheDecisionForGhArgs(args: string[]): CacheDecision {
  if (args.length === 0) return { ok: false };

  const sub = args[0];

  // Never cache anything that opens a browser or relies on interactive output.
  if (hasArg(args, "--web") || hasArg(args, "--browser")) return { ok: false };

  // Read-only gh api GET requests (including --paginate) are cacheable.
  if (sub === "api") {
    const target = args[1] || "";
    if (target === "graphql") {
      const query = getGraphqlQuery(args);
      if (query && isGraphqlMutation(query)) return { ok: false };
      // GraphQL requests are POST under the hood but typically read-only queries in our usage.
      return { ok: true, key: `gh\0${args.join("\0")}`, ttlMs: WATCH_INTERVAL_MS };
    }

    const method = getApiMethod(args);
    if (method !== "GET") return { ok: false };
    return { ok: true, key: `gh\0${args.join("\0")}`, ttlMs: WATCH_INTERVAL_MS };
  }

  // These list commands are read-only and frequently repeated.
  if (sub === "pr" && args[1] === "list") {
    // Avoid caching implicit-repo calls; require explicit --repo.
    if (!hasArg(args, "--repo")) return { ok: false };
    return { ok: true, key: `gh\0${args.join("\0")}`, ttlMs: WATCH_INTERVAL_MS };
  }

  if (sub === "run" && args[1] === "list") {
    if (!hasArg(args, "--repo")) return { ok: false };
    return { ok: true, key: `gh\0${args.join("\0")}`, ttlMs: WATCH_INTERVAL_MS };
  }

  return { ok: false };
}

function isGhNotFound(e: unknown): boolean {
  return (e as { code?: string }).code === "ENOENT";
}

function isRetryableError(e: unknown): boolean {
  const stderr = ((e as { stderr?: string }).stderr || "").toString();
  const message = ((e as Error).message || "").toString();
  return /\b(502|503)\b/.test(stderr + message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class GhNotFoundError extends Error {
  constructor() {
    super(
      "GitHub CLI (gh) is not installed or not in your PATH.\n" +
      "Install it from https://cli.github.com/"
    );
    this.name = "GhNotFoundError";
  }
}

export class GhNotAuthenticatedError extends Error {
  constructor() {
    super(
      "GitHub CLI (gh) is not authenticated.\n" +
      "Run: gh auth login"
    );
    this.name = "GhNotAuthenticatedError";
  }
}

/** Check that `gh` is installed and authenticated. */
export function ensureGh(): void {
  const provider = activeProvider();
  if (provider?.ensureGh) {
    provider.ensureGh();
    return;
  }
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch (e: unknown) {
    if (isGhNotFound(e)) throw new GhNotFoundError();
  }
  try {
    execFileSync("gh", ["auth", "token"], { stdio: "ignore" });
  } catch {
    throw new GhNotAuthenticatedError();
  }
}

/** True after a gh child process was killed by SIGINT/SIGTERM (set synchronously). */
export function isInterrupted(): boolean { return _interrupted; }

/** When enabled, gh() pipes stdio instead of inheriting the terminal (for TUI modes). */
export function setPipeStdio(on: boolean): void { _pipeStdio = on; }

export function gh(...args: string[]): string {
  const provider = activeProvider();
  if (provider?.gh) {
    return provider.gh(...args);
  }
  const stdio = _pipeStdio ? "pipe" as const : undefined;
  const decision = cacheDecisionForGhArgs(args);
  if (decision.ok) {
    const now = Date.now();
    maybePruneGhReadCache(now);
    const cached = ghReadCache.get(decision.key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execFileSync("gh", args, { encoding: "utf-8", timeout: GH_TIMEOUT_MS, stdio });
      if (decision.ok) {
        const now = Date.now();
        ghReadCache.set(decision.key, { value: out, expiresAt: now + decision.ttlMs });
      }
      return out;
    } catch (e: unknown) {
      if (isGhNotFound(e)) throw new GhNotFoundError();
      const sig = (e as { signal?: string }).signal;
      if (sig === "SIGINT" || sig === "SIGTERM") { _interrupted = true; throw e; }
      if (attempt < MAX_RETRIES && isRetryableError(e)) {
        sleepSync(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
}

/** Like gh() but suppresses stderr output (for use in TUI watch modes). */
export function ghQuiet(...args: string[]): string {
  const provider = activeProvider();
  if (provider?.ghQuiet) {
    return provider.ghQuiet(...args);
  }
  const decision = cacheDecisionForGhArgs(args);
  if (decision.ok) {
    const now = Date.now();
    maybePruneGhReadCache(now);
    const cached = ghReadCache.get(decision.key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execFileSync("gh", args, { encoding: "utf-8", timeout: GH_TIMEOUT_MS, stdio: "pipe" });
      if (decision.ok) {
        const now = Date.now();
        ghReadCache.set(decision.key, { value: out, expiresAt: now + decision.ttlMs });
      }
      return out;
    } catch (e: unknown) {
      if (isGhNotFound(e)) throw new GhNotFoundError();
      const sig = (e as { signal?: string }).signal;
      if (sig === "SIGINT" || sig === "SIGTERM") { _interrupted = true; throw e; }
      if (attempt < MAX_RETRIES && isRetryableError(e)) {
        sleepSync(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
}

/** Non-blocking variant of ghQuiet — keeps the event loop responsive for TUI key handling. */
export function ghQuietAsync(...args: string[]): Promise<string> {
  const provider = activeProvider();
  if (provider?.ghQuietAsync) {
    return provider.ghQuietAsync(...args);
  }
  const decision = cacheDecisionForGhArgs(args);
  if (decision.ok) {
    const now = Date.now();
    maybePruneGhReadCache(now);
    const cached = ghReadCache.get(decision.key);
    if (cached && cached.expiresAt > now) {
      return Promise.resolve(cached.value);
    }
  }
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryExec(): void {
      execFile("gh", args, { encoding: "utf-8", timeout: GH_TIMEOUT_MS }, (error, stdout) => {
        if (error) {
          if (isGhNotFound(error)) { reject(new GhNotFoundError()); return; }
          const sig = (error as { signal?: string }).signal;
          if (sig === "SIGINT" || sig === "SIGTERM") { _interrupted = true; reject(error); return; }
          if (attempt < MAX_RETRIES && isRetryableError(error)) {
            attempt++;
            setTimeout(tryExec, RETRY_BASE_MS * 2 ** (attempt - 1));
            return;
          }
          reject(error);
          return;
        }
        if (decision.ok) {
          const now = Date.now();
          ghReadCache.set(decision.key, { value: stdout, expiresAt: now + decision.ttlMs });
        }
        resolve(stdout);
      });
    }
    tryExec();
  });
}

let _cachedUser: string | null = null;
export function getCurrentUser(): string {
  const provider = activeProvider();
  if (provider?.getCurrentUser) {
    return provider.getCurrentUser();
  }
  if (!_cachedUser) {
    _cachedUser = gh("api", "user", "-q", ".login").trim();
  }
  return _cachedUser;
}

export function formatGhError(e: ExecError, context: string = ""): string {
  const stderr = e.stderr ?? (e.output?.[2] ?? "");
  const msg = (stderr || e.message || "").trim();
  const prefix = context ? `${context}: ` : "";
  return prefix + (msg || "Unknown error");
}

export const BOT_AUTHORS: Record<string, string> = {
  "app/dependabot": "depbot",
};

export function isBotPR(pr: PR): boolean {
  return (pr.author?.login ?? "") in BOT_AUTHORS;
}

export function getBotAgent(pr: PR): string | null {
  return BOT_AUTHORS[pr.author?.login ?? ""] ?? null;
}

export const AGENT_PATTERNS_WITH_LABELS: Record<string, AgentPatternWithLabels> = {
  cursor: {
    branch: /cursor/i,
    labels: ["cursor", "cursor-pr"],
  },
  claude: {
    branch: /claude/i,
    labels: ["claude", "claude-pr"],
  },
  copilot: {
    branch: /copilot/i,
    labels: ["copilot", "copilot-pr"],
  },
};

export const AGENT_BRANCH_PATTERNS: Record<string, RegExp> = {
  cursor: /^cursor\//i,
  claude: /^claude\//i,
  copilot: /^copilot\//i,
};

export function matchesAgent(pr: PR, agent: string | null): boolean {
  if (agent) {
    const pattern = AGENT_PATTERNS_WITH_LABELS[agent];
    if (!pattern) return false;
    const branchMatch = pattern.branch.test(pr.headRefName);
    const labelNames = (pr.labels || []).map((l) => l.name?.toLowerCase());
    const labelMatch = pattern.labels.some((l) => labelNames.includes(l));
    return branchMatch || labelMatch;
  }
  return Object.keys(AGENT_PATTERNS_WITH_LABELS).some((a) => matchesAgent(pr, a));
}

/** Returns the first matching agent for a PR, or null if none. */
export function getAgentForPR(pr: PR): string | null {
  for (const agent of Object.keys(AGENT_PATTERNS_WITH_LABELS)) {
    if (matchesAgent(pr, agent)) return agent;
  }
  return getBotAgent(pr);
}

/**
 * Batched check: for a set of PRs that didn't match by branch/label,
 * fetch recent commit authors via a single GraphQL query and test
 * against agent patterns. Returns PR numbers that matched.
 */
export function checkPRsForAgentCoAuthors(
  repo: string,
  prs: PR[],
  agent: string | null
): Set<number> {
  if (prs.length === 0) return new Set();

  const [owner, name] = repo.split("/");
  const patterns = agent
    ? [AGENT_PATTERNS_WITH_LABELS[agent]].filter(Boolean)
    : Object.values(AGENT_PATTERNS_WITH_LABELS);

  const matched = new Set<number>();

  for (let i = 0; i < prs.length; i += GRAPHQL_CHUNK_SIZE) {
    const chunk = prs.slice(i, i + GRAPHQL_CHUNK_SIZE);
    const prFragments = chunk.map(
      (pr) =>
        `pr_${pr.number}: pullRequest(number: ${pr.number}) {
          commits(last: ${COAUTHOR_SCAN_COMMIT_COUNT}) {
            nodes { commit { authors(first: 10) { nodes { name user { login } } } } }
          }
        }`
    );

    const query = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${prFragments.join("\n        ")}
      }
    }`;

    try {
      const out = gh(
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `name=${name}`
      );

      const repoData = (JSON.parse(out) as { data: { repository: Record<string, unknown> } })
        .data?.repository ?? {};

      for (const pr of chunk) {
        const prData = repoData[`pr_${pr.number}`] as {
          commits?: { nodes: Array<{ commit: { authors: { nodes: Array<{ name: string; user: { login: string } | null }> } } }> };
        } | undefined;
        const commits = prData?.commits?.nodes ?? [];
        for (const node of commits) {
          for (const author of node.commit?.authors?.nodes ?? []) {
            const login = author.user?.login ?? "";
            const authorName = author.name ?? "";
            if (patterns.some((p) => p.branch.test(login) || p.branch.test(authorName))) {
              matched.add(pr.number);
            }
          }
        }
      }
    } catch { /* skip chunk */ }
  }

  return matched;
}

export function listOpenPRs(repo: string, fields: string[]): PR[] {
  const provider = activeProvider();
  if (provider?.listOpenPRs) {
    return provider.listOpenPRs(repo, fields);
  }
  const out = gh(
    "pr", "list",
    "--repo", repo,
    "--state", "open",
    "--limit", "200",
    "--json", fields.join(",")
  );
  return JSON.parse(out) as PR[];
}

export async function listOpenPRsAsync(repo: string, fields: string[]): Promise<PR[]> {
  const provider = activeProvider();
  if (provider?.listOpenPRsAsync) {
    return provider.listOpenPRsAsync(repo, fields);
  }
  const out = await ghQuietAsync(
    "pr", "list",
    "--repo", repo,
    "--state", "open",
    "--limit", "200",
    "--json", fields.join(",")
  );
  return JSON.parse(out) as PR[];
}

export function listWorkflowRuns(repo: string, branch: string): WorkflowRun[] {
  const provider = activeProvider();
  if (provider?.listWorkflowRuns) {
    return provider.listWorkflowRuns(repo, branch);
  }
  try {
    const out = gh(
      "run", "list",
      "--repo", repo,
      "--branch", branch,
      "--limit", "100",
      "--json", "databaseId,name,conclusion,attempt,status,displayTitle"
    );
    const runs = JSON.parse(out || "[]");
    return Array.isArray(runs) ? (runs as WorkflowRun[]) : [];
  } catch {
    return [];
  }
}

export async function listWorkflowRunsAsync(repo: string, branch: string): Promise<WorkflowRun[]> {
  const provider = activeProvider();
  if (provider?.listWorkflowRunsAsync) {
    return provider.listWorkflowRunsAsync(repo, branch);
  }
  try {
    const out = await ghQuietAsync(
      "run", "list",
      "--repo", repo,
      "--branch", branch,
      "--limit", "100",
      "--json", "databaseId,name,conclusion,attempt,status,displayTitle"
    );
    const runs = JSON.parse(out || "[]");
    return Array.isArray(runs) ? (runs as WorkflowRun[]) : [];
  } catch {
    return [];
  }
}

export function listBranches(repo: string): string[] {
  const provider = activeProvider();
  if (provider?.listBranches) {
    return provider.listBranches(repo);
  }
  const out = gh("api", `repos/${repo}/branches`, "--paginate", "-q", ".[].name");
  return out.trim() ? out.trim().split("\n") : [];
}

export async function listBranchesAsync(repo: string): Promise<string[]> {
  const provider = activeProvider();
  if (provider?.listBranchesAsync) {
    return provider.listBranchesAsync(repo);
  }
  const out = await ghQuietAsync("api", `repos/${repo}/branches`, "--paginate", "-q", ".[].name");
  return out.trim() ? out.trim().split("\n") : [];
}

export async function getDefaultBranchAsync(repo: string): Promise<string> {
  const provider = activeProvider();
  if (provider?.getDefaultBranchAsync) {
    return provider.getDefaultBranchAsync(repo);
  }
  const out = await ghQuietAsync("api", `repos/${repo}`, "-q", ".default_branch");
  const branch = out.trim();
  if (!branch) {
    throw new Error(`Could not determine default branch for ${repo}`);
  }
  return branch;
}

const COMMIT_DELIM = "\x01";

export interface CommitInfo {
  message?: string;
  date: Date | null;
  authorLogin: string;
}

export function getResolvedCommentNodeIds(repo: string, prNumber: number): Set<string> {
  const [owner, name] = repo.split("/");
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            comments(first: 100) {
              nodes { id }
            }
          }
        }
      }
    }
  }`;
  try {
    const out = gh(
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-F", `number=${prNumber}`,
      "-q", ".data.repository.pullRequest.reviewThreads.nodes"
    );
    const threads = JSON.parse(out) as Array<{
      isResolved: boolean;
      comments: { nodes: Array<{ id: string }> };
    }>;
    const ids = new Set<string>();
    for (const t of threads) {
      if (t.isResolved) {
        for (const c of t.comments.nodes) ids.add(c.id);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

export function listPRReviewComments(repo: string, prNumber: number): PRReviewComment[] {
  const provider = activeProvider();
  if (provider?.listPRReviewComments) {
    return provider.listPRReviewComments(repo, prNumber);
  }
  try {
    const out = gh(
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--method", "GET",
      "-H", "Accept: application/vnd.github.v3.html+json",
      "-f", "per_page=100"
    );
    const arr = JSON.parse(out) as unknown;
    if (!Array.isArray(arr)) return [];
    const resolved = getResolvedCommentNodeIds(repo, prNumber);
    return (arr as PRReviewComment[]).filter(c => !resolved.has(c.node_id));
  } catch {
    return [];
  }
}

export function replyToPRComment(
  repo: string,
  prNumber: number,
  inReplyToId: number,
  body: string
): void {
  const provider = activeProvider();
  if (provider?.replyToPRCommentAsync) {
    void provider.replyToPRCommentAsync(repo, prNumber, inReplyToId, body);
    return;
  }
  gh(
    "api",
    `repos/${repo}/pulls/${prNumber}/comments/${inReplyToId}/replies`,
    "-X", "POST",
    "-f", `body=${body}`
  );
}

export async function replyToPRCommentAsync(
  repo: string,
  prNumber: number,
  inReplyToId: number,
  body: string
): Promise<void> {
  const provider = activeProvider();
  if (provider?.replyToPRCommentAsync) {
    await provider.replyToPRCommentAsync(repo, prNumber, inReplyToId, body);
    return;
  }
  await ghQuietAsync(
    "api",
    `repos/${repo}/pulls/${prNumber}/comments/${inReplyToId}/replies`,
    "-X", "POST",
    "-f", `body=${body}`
  );
}

export function resolveReviewThread(repo: string, prNumber: number, commentNodeId: string): void {
  const [owner, name] = repo.split("/");

  const threadQuery = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            comments(first: 100) {
              nodes { id }
            }
          }
        }
      }
    }
  }`;

  const out = gh(
    "api", "graphql",
    "-f", `query=${threadQuery}`,
    "-f", `owner=${owner}`,
    "-f", `name=${name}`,
    "-F", `number=${prNumber}`,
    "-q", ".data.repository.pullRequest.reviewThreads.nodes"
  );

  const threads = JSON.parse(out) as Array<{ id: string; comments: { nodes: Array<{ id: string }> } }>;
  const thread = threads.find(t => t.comments.nodes.some(c => c.id === commentNodeId));
  if (!thread) {
    throw new Error("Could not find review thread for this comment");
  }

  const resolveMutation = `mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }`;

  gh(
    "api", "graphql",
    "-f", `query=${resolveMutation}`,
    "-f", `threadId=${thread.id}`
  );
}

export function getUnresolvedCommentCounts(repo: string, prNumbers: number[]): Map<number, number> {
  const provider = activeProvider();
  if (provider?.getUnresolvedCommentCounts) {
    return provider.getUnresolvedCommentCounts(repo, prNumbers);
  }
  if (prNumbers.length === 0) return new Map();

  const [owner, name] = repo.split("/");
  const counts = new Map<number, number>();

  for (let i = 0; i < prNumbers.length; i += GRAPHQL_CHUNK_SIZE) {
    const chunk = prNumbers.slice(i, i + GRAPHQL_CHUNK_SIZE);
    const prFragments = chunk.map(
      (num) =>
        `pr_${num}: pullRequest(number: ${num}) {
          reviewThreads(first: 100) {
            nodes { isResolved }
          }
        }`
    );

    const query = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${prFragments.join("\n        ")}
      }
    }`;

    try {
      const out = gh(
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `name=${name}`
      );

      const repoData = (JSON.parse(out) as { data: { repository: Record<string, unknown> } })
        .data?.repository ?? {};

      for (const num of chunk) {
        const prData = repoData[`pr_${num}`] as {
          reviewThreads?: { nodes: Array<{ isResolved: boolean }> };
        } | undefined;
        const threads = prData?.reviewThreads?.nodes ?? [];
        counts.set(num, threads.filter(t => !t.isResolved).length);
      }
    } catch { /* skip chunk */ }
  }

  return counts;
}

export async function getUnresolvedCommentCountsAsync(repo: string, prNumbers: number[]): Promise<Map<number, number>> {
  const provider = activeProvider();
  if (provider?.getUnresolvedCommentCountsAsync) {
    return provider.getUnresolvedCommentCountsAsync(repo, prNumbers);
  }
  if (prNumbers.length === 0) return new Map();

  const [owner, name] = repo.split("/");
  const counts = new Map<number, number>();

  for (let i = 0; i < prNumbers.length; i += GRAPHQL_CHUNK_SIZE) {
    const chunk = prNumbers.slice(i, i + GRAPHQL_CHUNK_SIZE);
    const prFragments = chunk.map(
      (num) =>
        `pr_${num}: pullRequest(number: ${num}) {
          reviewThreads(first: 100) {
            nodes { isResolved }
          }
        }`
    );

    const query = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${prFragments.join("\n        ")}
      }
    }`;

    try {
      const out = await ghQuietAsync(
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `name=${name}`
      );

      const repoData = (JSON.parse(out) as { data: { repository: Record<string, unknown> } })
        .data?.repository ?? {};

      for (const num of chunk) {
        const prData = repoData[`pr_${num}`] as {
          reviewThreads?: { nodes: Array<{ isResolved: boolean }> };
        } | undefined;
        const threads = prData?.reviewThreads?.nodes ?? [];
        counts.set(num, threads.filter(t => !t.isResolved).length);
      }
    } catch { /* skip chunk */ }
  }

  return counts;
}

export async function getResolvedCommentNodeIdsAsync(repo: string, prNumber: number): Promise<Set<string>> {
  const [owner, name] = repo.split("/");
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            comments(first: 100) {
              nodes { id }
            }
          }
        }
      }
    }
  }`;
  try {
    const out = await ghQuietAsync(
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-F", `number=${prNumber}`,
      "-q", ".data.repository.pullRequest.reviewThreads.nodes"
    );
    const threads = JSON.parse(out) as Array<{
      isResolved: boolean;
      comments: { nodes: Array<{ id: string }> };
    }>;
    const ids = new Set<string>();
    for (const t of threads) {
      if (t.isResolved) {
        for (const c of t.comments.nodes) ids.add(c.id);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

export async function listPRReviewCommentsAsync(repo: string, prNumber: number): Promise<PRReviewComment[]> {
  const provider = activeProvider();
  if (provider?.listPRReviewCommentsAsync) {
    return provider.listPRReviewCommentsAsync(repo, prNumber);
  }
  try {
    const out = await ghQuietAsync(
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--method", "GET",
      "-H", "Accept: application/vnd.github.v3.html+json",
      "-f", "per_page=100"
    );
    const arr = JSON.parse(out) as unknown;
    if (!Array.isArray(arr)) return [];
    const resolved = await getResolvedCommentNodeIdsAsync(repo, prNumber);
    return (arr as PRReviewComment[]).filter(c => !resolved.has(c.node_id));
  } catch {
    return [];
  }
}

export async function addPRCommentAsync(repo: string, prNumber: number, body: string): Promise<void> {
  const provider = activeProvider();
  if (provider?.addPRCommentAsync) {
    await provider.addPRCommentAsync(repo, prNumber, body);
    return;
  }
  await ghQuietAsync("pr", "comment", String(prNumber), "--repo", repo, "--body", body);
}

export function listPRFiles(repo: string, prNumber: number): PRChangedFile[] {
  const provider = activeProvider();
  if (provider?.listPRFiles) {
    return provider.listPRFiles(repo, prNumber);
  }
  try {
    const out = gh(
      "api",
      `repos/${repo}/pulls/${prNumber}/files`,
      "--method", "GET",
      "-f", "per_page=100"
    );
    const arr = JSON.parse(out) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr as PRChangedFile[];
  } catch {
    return [];
  }
}

export async function listPRFilesAsync(repo: string, prNumber: number): Promise<PRChangedFile[]> {
  const provider = activeProvider();
  if (provider?.listPRFilesAsync) {
    return provider.listPRFilesAsync(repo, prNumber);
  }
  try {
    const out = await ghQuietAsync(
      "api",
      `repos/${repo}/pulls/${prNumber}/files`,
      "--method", "GET",
      "-f", "per_page=100"
    );
    const arr = JSON.parse(out) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr as PRChangedFile[];
  } catch {
    return [];
  }
}

export function getCommitInfo(repo: string, branchRef: string, includeMessage: boolean = false): CommitInfo {
  const provider = activeProvider();
  if (provider?.getCommitInfo) {
    const info = provider.getCommitInfo(repo, branchRef, includeMessage);
    return {
      message: info.message,
      date: info.date,
      authorLogin: info.authorLogin,
    };
  }
  const ref = encodeURIComponent(branchRef);
  const query = includeMessage
    ? `.commit.message + "${COMMIT_DELIM}" + .commit.author.date + "${COMMIT_DELIM}" + (.author.login // "")`
    : `.commit.author.date + "${COMMIT_DELIM}" + (.author.login // "")`;
  
  const out = gh("api", `repos/${repo}/commits/${ref}`, "-q", query);
  const parts = out.trim().split(COMMIT_DELIM);
  
  if (includeMessage) {
    const [message, dateStr, authorLogin] = parts;
    return {
      message: (message || "").trim(),
      date: dateStr ? new Date(dateStr.trim()) : null,
      authorLogin: (authorLogin || "").trim(),
    };
  } else {
    const [dateStr, authorLogin] = parts;
    return {
      date: dateStr ? new Date(dateStr.trim()) : null,
      authorLogin: (authorLogin || "").trim(),
    };
  }
}

export async function getCommitInfoAsync(repo: string, branchRef: string, includeMessage: boolean = false): Promise<CommitInfo> {
  const provider = activeProvider();
  if (provider?.getCommitInfoAsync) {
    const info = await provider.getCommitInfoAsync(repo, branchRef, includeMessage);
    return {
      message: info.message,
      date: info.date,
      authorLogin: info.authorLogin,
    };
  }
  const ref = encodeURIComponent(branchRef);
  const query = includeMessage
    ? `.commit.message + "${COMMIT_DELIM}" + .commit.author.date + "${COMMIT_DELIM}" + (.author.login // "")`
    : `.commit.author.date + "${COMMIT_DELIM}" + (.author.login // "")`;

  const out = await ghQuietAsync("api", `repos/${repo}/commits/${ref}`, "-q", query);
  const parts = out.trim().split(COMMIT_DELIM);

  if (includeMessage) {
    const [message, dateStr, authorLogin] = parts;
    return {
      message: (message || "").trim(),
      date: dateStr ? new Date(dateStr.trim()) : null,
      authorLogin: (authorLogin || "").trim(),
    };
  }

  const [dateStr, authorLogin] = parts;
  return {
    date: dateStr ? new Date(dateStr.trim()) : null,
    authorLogin: (authorLogin || "").trim(),
  };
}
