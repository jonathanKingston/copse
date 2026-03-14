import { ghQuietAsync, addPRCommentAsync, replyToPRCommentAsync, validateAgent, validateRepo } from "../gh.js";
import type { WorkflowRun } from "../types.js";
import { sendReplyViaCursorApi } from "../cursor-replies.js";
import { invalidateStatusCache } from "./status-service.js";

const UP_TO_DATE_ERRORS = ["nothing to merge", "already up to date"];

function messageFromError(error: unknown): string {
  return ((error as { stderr?: string }).stderr || (error as Error).message || "").trim();
}

function includesAny(text: string, values: string[]): boolean {
  const lowered = text.toLowerCase();
  return values.some((value) => lowered.includes(value));
}

export interface BulkResult {
  total: number;
}

export interface MergeBaseResult {
  updated: boolean;
  alreadyUpToDate: boolean;
}

export async function rerunFailedWorkflowRuns(repo: string, headRefName: string): Promise<BulkResult> {
  validateRepo(repo);
  const runsJson = await ghQuietAsync(
    "run", "list",
    "--repo", repo,
    "--branch", headRefName,
    "--limit", "100",
    "--json", "databaseId,name,conclusion,attempt,status,displayTitle"
  );
  const runs = JSON.parse(runsJson || "[]") as WorkflowRun[];
  const failedRuns = runs.filter((run) => run.conclusion === "failure");

  let total = 0;
  for (const run of failedRuns) {
    try {
      await ghQuietAsync("run", "rerun", String(run.databaseId), "--repo", repo, "--failed");
      total++;
    } catch {
      // Continue with remaining runs.
    }
  }

  if (total > 0) invalidateStatusCache();
  return { total };
}

export async function mergeBaseIntoBranch(
  repo: string,
  headRefName: string,
  baseBranch: string = "main"
): Promise<MergeBaseResult> {
  validateRepo(repo);
  try {
    await ghQuietAsync("api", `repos/${repo}/merges`, "-f", `base=${headRefName}`, "-f", `head=${baseBranch}`);
    invalidateStatusCache();
    return { updated: true, alreadyUpToDate: false };
  } catch (error: unknown) {
    const message = messageFromError(error);
    if (includesAny(message, UP_TO_DATE_ERRORS)) {
      return { updated: false, alreadyUpToDate: true };
    }
    throw error;
  }
}

export async function approvePullRequest(repo: string, prNumber: number): Promise<void> {
  validateRepo(repo);
  await ghQuietAsync("pr", "review", "--repo", repo, String(prNumber), "--approve");
  invalidateStatusCache();
}

export async function enableMergeWhenReady(repo: string, prNumber: number): Promise<void> {
  validateRepo(repo);
  await ghQuietAsync("pr", "merge", "--repo", repo, String(prNumber), "--auto");
  invalidateStatusCache();
}

export async function postPullRequestComment(repo: string, prNumber: number, body: string): Promise<void> {
  validateRepo(repo);
  if (!body.trim()) {
    throw new Error("comment body cannot be empty");
  }
  await addPRCommentAsync(repo, prNumber, body);
}

export async function postPullRequestReply(params: {
  repo: string;
  prNumber: number;
  inReplyToId: number;
  body: string;
  cursorApiKey?: string | null;
}): Promise<{ mode: "github" | "cursor-followup" | "cursor-launch" }> {
  const { repo, prNumber, inReplyToId, body, cursorApiKey } = params;
  validateRepo(repo);
  if (!body.trim()) {
    throw new Error("reply body cannot be empty");
  }

  if (cursorApiKey && cursorApiKey.trim()) {
    const result = await sendReplyViaCursorApi({
      repo,
      prNumber,
      replyText: body,
      cursorApiKey,
    });
    return { mode: result.mode === "followup" ? "cursor-followup" : "cursor-launch" };
  }

  await replyToPRCommentAsync(repo, prNumber, inReplyToId, body);
  return { mode: "github" };
}

export interface ChainMergeStep {
  fromPR: number;
  intoPR: number | "default";
  success: boolean;
  alreadyUpToDate?: boolean;
  error?: string;
}

export interface ChainMergeResult {
  steps: ChainMergeStep[];
  stoppedEarly: boolean;
}

/**
 * Merges a chain of PRs into each other in order.
 * For PRs [A, B, C], merges A's branch into B's branch, then B's into C's branch.
 * If all intermediate merges succeed cleanly, enables auto-merge on the last PR
 * into the default branch.
 *
 * Stops at the first merge that fails (conflict or error).
 */
export async function chainMergePRs(
  repo: string,
  prs: Array<{ number: number; headRefName: string }>,
  defaultBranch: string = "main"
): Promise<ChainMergeResult> {
  validateRepo(repo);
  if (prs.length < 2) {
    throw new Error("Chain merge requires at least 2 PRs");
  }

  const steps: ChainMergeStep[] = [];
  let stoppedEarly = false;

  // Merge each PR's branch into the next PR's branch
  for (let i = 0; i < prs.length - 1; i++) {
    const from = prs[i];
    const into = prs[i + 1];

    try {
      // Use the GitHub merges API: merge from.headRefName into into.headRefName
      await ghQuietAsync(
        "api", `repos/${repo}/merges`,
        "-f", `base=${into.headRefName}`,
        "-f", `head=${from.headRefName}`
      );
      steps.push({ fromPR: from.number, intoPR: into.number, success: true });
    } catch (error: unknown) {
      const message = messageFromError(error);
      if (includesAny(message, UP_TO_DATE_ERRORS)) {
        steps.push({ fromPR: from.number, intoPR: into.number, success: true, alreadyUpToDate: true });
      } else {
        steps.push({ fromPR: from.number, intoPR: into.number, success: false, error: message || "merge conflict or error" });
        stoppedEarly = true;
        break;
      }
    }
  }

  // If all intermediate merges succeeded, update the base branch of each
  // intermediate PR to point to the next PR's branch, and enable auto-merge
  // on the last PR into the default branch.
  if (!stoppedEarly) {
    const lastPR = prs[prs.length - 1];

    // Retarget intermediate PRs so they merge into the next PR's branch
    for (let i = 0; i < prs.length - 1; i++) {
      const pr = prs[i];
      const nextPR = prs[i + 1];
      try {
        await ghQuietAsync(
          "pr", "edit", String(pr.number),
          "--repo", repo,
          "--base", nextPR.headRefName
        );
      } catch {
        // Best effort - retargeting may fail if branch protection prevents it
      }
    }

    // Enable auto-merge on the last PR
    try {
      await ghQuietAsync("pr", "merge", "--repo", repo, String(lastPR.number), "--auto");
      steps.push({ fromPR: lastPR.number, intoPR: "default", success: true });
    } catch (error: unknown) {
      const message = messageFromError(error);
      if (includesAny(message, ["already"])) {
        steps.push({ fromPR: lastPR.number, intoPR: "default", success: true, alreadyUpToDate: true });
      } else {
        steps.push({ fromPR: lastPR.number, intoPR: "default", success: false, error: message });
      }
    }
  }

  invalidateStatusCache();
  return { steps, stoppedEarly };
}

export async function createIssueWithAgentComment(params: {
  repo: string;
  title: string;
  body: string;
  agent: string;
  templateChoice: 0 | 1 | 2 | 3;
}): Promise<{ issueNumber: number; commentAdded: boolean }> {
  const { repo, title, body, agent, templateChoice } = params;
  validateRepo(repo);
  const validatedAgent = validateAgent(agent);
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw new Error("issue title cannot be empty");
  }

  const issueBody = body.trim() || ".";
  const out = await ghQuietAsync(
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    trimmedTitle,
    "--body",
    issueBody
  );
  const match = out.trim().match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (!match) {
    throw new Error("failed to parse issue number from GitHub response");
  }
  const issueNumber = parseInt(match[1], 10);

  const selectedTemplate = getIssueTemplateComment(validatedAgent, templateChoice);
  if (selectedTemplate) {
    await ghQuietAsync("issue", "comment", String(issueNumber), "--repo", repo, "--body", selectedTemplate);
    return { issueNumber, commentAdded: true };
  }

  return { issueNumber, commentAdded: false };
}

export function getIssueTemplateComment(agent: string, templateChoice: 0 | 1 | 2 | 3): string | null {
  const validatedAgent = validateAgent(agent);
  const mention =
    validatedAgent === "cursor"
      ? "@cursor"
      : validatedAgent === "claude"
        ? "@claude"
        : "@copilot";

  const templates: Array<string | null> = [
    null,
    `${mention} please deeply research this issue. Look at the codebase and related code, and provide a thorough analysis of what's involved, what the root cause is, and what options exist.`,
    `${mention} please look at the codebase and create a detailed plan for implementing this. Don't make changes yet, just outline the approach, which files need changing, and any trade-offs.`,
    `${mention} please go and build this.`,
  ];
  return templates[templateChoice];
}
