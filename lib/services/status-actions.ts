import {
  ghQuietAsync,
  addPRCommentAsync,
  getCommitInfoAsync,
  getDefaultBranchAsync,
  replyToPRCommentAsync,
  validateAgent,
  validateRepo,
} from "../gh.js";
import type { WorkflowRun } from "../types.js";
import { sendReplyViaCursorApi } from "../cursor-replies.js";
import { launchAgentForPrUrl, launchAgentForRepository } from "../cursor-api.js";
import { invalidateStatusCache } from "./status-service.js";

const UP_TO_DATE_ERRORS = ["nothing to merge", "already up to date"];
const AUTO_MERGE_ALREADY_ERRORS = ["already enabled", "already in", "already queued"];
const AUTO_MERGE_DRAFT_ERRORS = ["draft", "enablepullrequestautomerge"];
const RETARGET_REDUNDANT_ERRORS = ["there are no new commits between base branch"];
const MERGE_STRATEGY_FLAGS = ["--squash", "--merge", "--rebase"];

function messageFromError(error: unknown): string {
  return ((error as { stderr?: string }).stderr || (error as Error).message || "").trim();
}

function includesAny(text: string, values: string[]): boolean {
  const lowered = text.toLowerCase();
  return values.some((value) => lowered.includes(value));
}

interface StatusActionDeps {
  ghQuietAsync: typeof ghQuietAsync;
  addPRCommentAsync: typeof addPRCommentAsync;
  getCommitInfoAsync: typeof getCommitInfoAsync;
  getDefaultBranchAsync: typeof getDefaultBranchAsync;
  invalidateStatusCache: typeof invalidateStatusCache;
}

const DEFAULT_DEPS: StatusActionDeps = {
  ghQuietAsync,
  addPRCommentAsync,
  getCommitInfoAsync,
  getDefaultBranchAsync,
  invalidateStatusCache,
};
const autoMergeStrategyCache = new Map<string, string>();

function parseCommitMessage(message: string): { title: string; body: string } {
  const lines = String(message || "").split("\n");
  return {
    title: (lines[0] || "").trim(),
    body: lines.slice(1).join("\n").trim(),
  };
}

export interface BulkResult {
  total: number;
}

export interface CreatePullRequestForBranchResult {
  title: string;
  body: string;
  baseBranch: string;
  url: string;
}

export async function createPullRequestForBranch(
  repo: string,
  headRefName: string,
  deps: StatusActionDeps = DEFAULT_DEPS
): Promise<CreatePullRequestForBranchResult> {
  validateRepo(repo);
  if (!headRefName.trim()) {
    throw new Error("headRefName cannot be empty");
  }

  const [{ message }, baseBranch] = await Promise.all([
    deps.getCommitInfoAsync(repo, headRefName, true),
    deps.getDefaultBranchAsync(repo),
  ]);
  const parsed = parseCommitMessage(message || "");
  const title = parsed.title || headRefName;
  const body = parsed.body;
  const args = [
    "pr", "create",
    "--repo", repo,
    "--base", baseBranch,
    "--head", headRefName,
    "--title", title,
  ];
  if (body) {
    args.push("--body", body);
  }

  const out = await deps.ghQuietAsync(...args);
  const url = out.trim().split("\n").find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+\/?$/.test(line.trim()))?.trim() || out.trim();
  if (!url) {
    throw new Error(`Failed to parse created PR URL for ${headRefName}`);
  }

  deps.invalidateStatusCache();
  return { title, body, baseBranch, url };
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

export interface MarkPullRequestReadyResult {
  markedReady: boolean;
  alreadyReady: boolean;
}

export async function markPullRequestReady(
  repo: string,
  prNumber: number,
  deps: StatusActionDeps = DEFAULT_DEPS
): Promise<MarkPullRequestReadyResult> {
  validateRepo(repo);
  const isDraft = (await deps.ghQuietAsync(
    "pr", "view", String(prNumber),
    "--repo", repo,
    "--json", "isDraft",
    "-q", ".isDraft"
  )).trim() === "true";
  if (!isDraft) {
    return { markedReady: false, alreadyReady: true };
  }
  await deps.ghQuietAsync("pr", "ready", String(prNumber), "--repo", repo);
  deps.invalidateStatusCache();
  return { markedReady: true, alreadyReady: false };
}

export interface RetargetPullRequestResult {
  retargeted: boolean;
  closedRedundant: boolean;
  alreadyTargeted: boolean;
}

export async function retargetPullRequest(
  repo: string,
  prNumber: number,
  baseBranch: string,
  deps: StatusActionDeps = DEFAULT_DEPS
): Promise<RetargetPullRequestResult> {
  validateRepo(repo);
  if (!baseBranch.trim()) {
    throw new Error("baseBranch cannot be empty");
  }
  const currentBase = (await deps.ghQuietAsync(
    "pr", "view", String(prNumber),
    "--repo", repo,
    "--json", "baseRefName",
    "-q", ".baseRefName"
  )).trim();
  if (currentBase === baseBranch) {
    return { retargeted: false, closedRedundant: false, alreadyTargeted: true };
  }
  try {
    await deps.ghQuietAsync("pr", "edit", String(prNumber), "--repo", repo, "--base", baseBranch);
    deps.invalidateStatusCache();
    return { retargeted: true, closedRedundant: false, alreadyTargeted: false };
  } catch (error: unknown) {
    const message = messageFromError(error);
    if (!includesAny(message, RETARGET_REDUNDANT_ERRORS)) {
      throw error;
    }

    const explanation = [
      `Closing this PR because retargeting it onto \`${baseBranch}\` showed there are no commits unique to this branch beyond that base.`,
      "",
      "This PR is redundant in the current stack, so the queue will continue without it.",
    ].join("\n");

    await deps.addPRCommentAsync(repo, prNumber, explanation);
    await deps.ghQuietAsync("pr", "close", String(prNumber), "--repo", repo);
    deps.invalidateStatusCache();
    return { retargeted: false, closedRedundant: true, alreadyTargeted: false };
  }
}

export interface EnableMergeWhenReadyResult {
  enabled: boolean;
  alreadyEnabled: boolean;
}

async function getAutoMergeStrategy(repo: string, deps: StatusActionDeps): Promise<string> {
  const cached = autoMergeStrategyCache.get(repo);
  if (cached) {
    return cached;
  }

  const out = await deps.ghQuietAsync(
    "api",
    `repos/${repo}`,
    "-q",
    "{allowSquashMerge: .allow_squash_merge, allowMergeCommit: .allow_merge_commit, allowRebaseMerge: .allow_rebase_merge}"
  );
  const settings = JSON.parse(out) as {
    allowSquashMerge?: boolean;
    allowMergeCommit?: boolean;
    allowRebaseMerge?: boolean;
  };

  const strategy = settings.allowSquashMerge
    ? "--squash"
    : settings.allowMergeCommit
      ? "--merge"
      : settings.allowRebaseMerge
        ? "--rebase"
        : null;

  if (!strategy) {
    throw new Error(`Cannot enable auto-merge for ${repo}: repository does not allow squash, merge, or rebase merges.`);
  }

  autoMergeStrategyCache.set(repo, strategy);
  return strategy;
}

export async function enableMergeWhenReady(
  repo: string,
  prNumber: number,
  deps: StatusActionDeps = DEFAULT_DEPS
): Promise<EnableMergeWhenReadyResult> {
  validateRepo(repo);
  try {
    const strategy = await getAutoMergeStrategy(repo, deps);
    await deps.ghQuietAsync("pr", "merge", "--repo", repo, String(prNumber), "--auto", strategy);
    deps.invalidateStatusCache();
    return { enabled: true, alreadyEnabled: false };
  } catch (error: unknown) {
    const message = messageFromError(error);
    if (includesAny(message, AUTO_MERGE_ALREADY_ERRORS)) {
      return { enabled: false, alreadyEnabled: true };
    }
    if (includesAny(message, AUTO_MERGE_DRAFT_ERRORS)) {
      throw new Error(
        `Cannot enable merge when ready on #${prNumber}: PR is still in draft. Mark it as ready for review first.`
      );
    }
    if (includesAny(message, ["--merge, --rebase, or --squash required"])) {
      throw new Error(
        `Cannot enable merge when ready on #${prNumber}: GitHub CLI needs an explicit merge strategy for this repository.`
      );
    }
    throw error;
  }
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
  action: "retarget" | "auto-merge";
  prNumber: number;
  intoPR: number | "default";
  success: boolean;
  alreadyEnabled?: boolean;
  closedRedundant?: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ChainMergeResult {
  steps: ChainMergeStep[];
  stoppedEarly: boolean;
}

/**
 * Queues a PR stack by retargeting each PR to the next PR's branch.
 * For PRs [A, B, C], retargets A to B's branch, B to C's branch, and leaves C
 * targeting the default branch. Then it enables auto-merge on each PR so the
 * stack can merge in order as GitHub conditions are satisfied.
 *
 * Stops at the first retarget or auto-merge action that fails.
 */
export async function chainMergePRs(
  repo: string,
  prs: Array<{ number: number; headRefName: string }>,
  defaultBranch: string = "main",
  deps: StatusActionDeps = DEFAULT_DEPS
): Promise<ChainMergeResult> {
  validateRepo(repo);
  if (prs.length < 2) {
    throw new Error("Chain merge requires at least 2 PRs");
  }

  void defaultBranch;

  const steps: ChainMergeStep[] = [];
  const closedRedundantPRs = new Set<number>();
  let stoppedEarly = false;

  // Retarget each intermediate PR to the next PR's branch.
  for (let i = 0; i < prs.length - 1; i++) {
    const pr = prs[i];
    const nextPR = prs[i + 1];

    try {
      const result = await retargetPullRequest(repo, pr.number, nextPR.headRefName, deps);
      steps.push({
        action: "retarget",
        prNumber: pr.number,
        intoPR: nextPR.number,
        success: true,
        closedRedundant: result.closedRedundant,
      });
      if (result.closedRedundant) {
        closedRedundantPRs.add(pr.number);
      }
    } catch (error: unknown) {
      const message = messageFromError(error);
      steps.push({ action: "retarget", prNumber: pr.number, intoPR: nextPR.number, success: false, error: message || "failed to retarget PR" });
      stoppedEarly = true;
      break;
    }
  }

  // If retargeting succeeded, enable auto-merge on each PR in stack order.
  if (!stoppedEarly) {
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      const target = i < prs.length - 1 ? prs[i + 1].number : "default";
      if (closedRedundantPRs.has(pr.number)) {
        steps.push({
          action: "auto-merge",
          prNumber: pr.number,
          intoPR: target,
          success: true,
          skipped: true,
        });
        continue;
      }
      try {
        const result = await enableMergeWhenReady(repo, pr.number, deps);
        steps.push({
          action: "auto-merge",
          prNumber: pr.number,
          intoPR: target,
          success: true,
          alreadyEnabled: result.alreadyEnabled,
        });
      } catch (error: unknown) {
        const message = messageFromError(error);
        steps.push({ action: "auto-merge", prNumber: pr.number, intoPR: target, success: false, error: message || "failed to enable auto-merge" });
        stoppedEarly = true;
        break;
      }
    }
  }

  deps.invalidateStatusCache();
  return { steps, stoppedEarly };
}

export async function createIssueWithAgentComment(params: {
  repo: string;
  title: string;
  body: string;
  agent: string;
  templateChoice: 0 | 1 | 2 | 3;
  cursorApiKey?: string | null;
  targetPr?: number | null;
}): Promise<{ issueNumber: number; commentAdded: boolean; cursorAgentLaunched: boolean }> {
  const { repo, title, body, agent, templateChoice, cursorApiKey, targetPr } = params;
  validateRepo(repo);
  const validatedAgent = validateAgent(agent);
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw new Error("issue title cannot be empty");
  }

  const shouldUseCursorApi = validatedAgent === "cursor" && Boolean(cursorApiKey);
  if (targetPr && !shouldUseCursorApi) {
    throw new Error("targetPr requires the Cursor API (agent=cursor with cursorApiKey configured)");
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
  if (!selectedTemplate) {
    return { issueNumber, commentAdded: false, cursorAgentLaunched: false };
  }

  if (shouldUseCursorApi) {
    const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
    const instruction = stripMention(selectedTemplate, validatedAgent);
    const prompt = `${instruction}\n\nIssue: ${issueUrl}`;

    if (targetPr) {
      const prUrl = `https://github.com/${repo}/pull/${targetPr}`;
      await launchAgentForPrUrl(cursorApiKey!, prUrl, prompt);
    } else {
      await launchAgentForRepository(
        cursorApiKey!,
        `https://github.com/${repo}`,
        prompt,
        { autoCreatePr: true, openAsCursorGithubApp: true }
      );
    }
    return { issueNumber, commentAdded: false, cursorAgentLaunched: true };
  }

  await ghQuietAsync("issue", "comment", String(issueNumber), "--repo", repo, "--body", selectedTemplate);
  return { issueNumber, commentAdded: true, cursorAgentLaunched: false };
}

function stripMention(comment: string, agent: string): string {
  const mention = `@${agent}`;
  const trimmed = comment.trim();
  if (trimmed.toLowerCase().startsWith(mention.toLowerCase())) {
    return trimmed.slice(mention.length).trimStart();
  }
  return trimmed;
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
