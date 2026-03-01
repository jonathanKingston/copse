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

export function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8" });
}

export function getCurrentUser(): string {
  return gh("api", "user", "-q", ".login").trim();
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

export function listPRReviewComments(repo: string, prNumber: number): PRReviewComment[] {
  try {
    const out = gh(
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--method", "GET",
      "-f", "per_page=100"
    );
    const arr = JSON.parse(out) as unknown;
    return Array.isArray(arr) ? (arr as PRReviewComment[]) : [];
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
    `repos/${repo}/pulls/${prNumber}/comments`,
    "-X", "POST",
    "-f", `body=${body}`,
    "-f", `in_reply_to=${inReplyToId}`
  );
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
