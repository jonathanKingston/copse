import { execFileSync } from "child_process";
import type { PR, AgentPatternWithLabels, ExecError, WorkflowRun, PRReviewComment } from "./types.js";

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

let _interrupted = false;
let _pipeStdio = false;

/** True after a gh child process was killed by SIGINT/SIGTERM (set synchronously). */
export function isInterrupted(): boolean { return _interrupted; }

/** When enabled, gh() pipes stdio instead of inheriting the terminal (for TUI modes). */
export function setPipeStdio(on: boolean): void { _pipeStdio = on; }

export function gh(...args: string[]): string {
  const stdio = _pipeStdio ? "pipe" as const : undefined;
  try {
    return execFileSync("gh", args, { encoding: "utf-8", timeout: GH_TIMEOUT_MS, stdio });
  } catch (e: unknown) {
    const sig = (e as { signal?: string }).signal;
    if (sig === "SIGINT" || sig === "SIGTERM") _interrupted = true;
    throw e;
  }
}

/** Like gh() but suppresses stderr output (for use in TUI watch modes). */
export function ghQuiet(...args: string[]): string {
  try {
    return execFileSync("gh", args, { encoding: "utf-8", timeout: GH_TIMEOUT_MS, stdio: "pipe" });
  } catch (e: unknown) {
    const sig = (e as { signal?: string }).signal;
    if (sig === "SIGINT" || sig === "SIGTERM") _interrupted = true;
    throw e;
  }
}

let _cachedUser: string | null = null;
export function getCurrentUser(): string {
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
  return null;
}

/**
 * Batched check: for a set of PRs that didn't match by branch/label,
 * fetch only the last commit's authors via a single GraphQL query
 * and test against agent patterns. Returns PR numbers that matched.
 */
export function checkPRsForAgentCoAuthors(
  repo: string,
  prs: PR[],
  agent: string | null
): Set<number> {
  if (prs.length === 0) return new Set();

  const [owner, name] = repo.split("/");

  const prFragments = prs.map(
    (pr) =>
      `pr_${pr.number}: pullRequest(number: ${pr.number}) {
        commits(last: 1) {
          nodes { commit { authors(first: 10) { nodes { name user { login } } } } }
        }
      }`
  );

  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${prFragments.join("\n      ")}
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

    const patterns = agent
      ? [AGENT_PATTERNS_WITH_LABELS[agent]].filter(Boolean)
      : Object.values(AGENT_PATTERNS_WITH_LABELS);

    const matched = new Set<number>();
    for (const pr of prs) {
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
    return matched;
  } catch {
    return new Set();
  }
}

export function listOpenPRs(repo: string, fields: string[]): PR[] {
  const out = gh(
    "pr", "list",
    "--repo", repo,
    "--state", "open",
    "--limit", "200",
    "--json", fields.join(",")
  );
  return JSON.parse(out) as PR[];
}

export function listWorkflowRuns(repo: string, branch: string): WorkflowRun[] {
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

export function listBranches(repo: string): string[] {
  const out = gh("api", `repos/${repo}/branches`, "--paginate", "-q", ".[].name");
  return out.trim() ? out.trim().split("\n") : [];
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
  try {
    const out = gh(
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--method", "GET",
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
  gh(
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
  if (prNumbers.length === 0) return new Map();

  const [owner, name] = repo.split("/");
  const prFragments = prNumbers.map(
    (num) =>
      `pr_${num}: pullRequest(number: ${num}) {
        reviewThreads(first: 100) {
          nodes { isResolved }
        }
      }`
  );

  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${prFragments.join("\n      ")}
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

    const counts = new Map<number, number>();
    for (const num of prNumbers) {
      const prData = repoData[`pr_${num}`] as {
        reviewThreads?: { nodes: Array<{ isResolved: boolean }> };
      } | undefined;
      const threads = prData?.reviewThreads?.nodes ?? [];
      counts.set(num, threads.filter(t => !t.isResolved).length);
    }
    return counts;
  } catch {
    return new Map();
  }
}

export function getCommitInfo(repo: string, branchRef: string, includeMessage: boolean = false): CommitInfo {
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
