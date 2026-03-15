import type { IncomingMessage, ServerResponse } from "node:http";
import { validateRepo } from "../../lib/gh.js";
import {
  approvePullRequest,
  chainMergePRs,
  createPullRequestForBranch,
  createIssueWithAgentComment,
  enableMergeWhenReady,
  markPullRequestReady,
  mergeBaseIntoBranch,
  retargetPullRequest,
  rerunFailedWorkflowRuns,
} from "../../lib/services/status-actions.js";
import {
  sendJson,
  readJsonBody,
  parsePathSegments,
  parsePrTarget,
} from "./helpers.js";

export async function handleActionRoutes(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
  const method = req.method || "GET";
  const segments = parsePathSegments(url);

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
    return true;
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
    return true;
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
    return true;
  }

  const target = parsePrTarget(segments);
  if (method === "POST" && target) {
    if (target.action === "rerun") {
      const body = await readJsonBody(req);
      const result = await rerunFailedWorkflowRuns(target.repo, String(body.headRefName || ""));
      sendJson(res, 200, { ok: true, total: result.total, message: `Reran ${result.total} workflow(s)` });
      return true;
    }
    if (target.action === "update-main") {
      const body = await readJsonBody(req);
      const headRefName = String(body.headRefName || "");
      const result = await mergeBaseIntoBranch(target.repo, headRefName, "main");
      sendJson(res, 200, {
        ok: true,
        alreadyUpToDate: result.alreadyUpToDate,
        message: result.alreadyUpToDate ? "Already up to date with main" : "Merged main into branch",
      });
      return true;
    }
    if (target.action === "approve") {
      await approvePullRequest(target.repo, target.prNumber);
      sendJson(res, 200, { ok: true, message: "Approved PR" });
      return true;
    }
    if (target.action === "ready") {
      const result = await markPullRequestReady(target.repo, target.prNumber);
      sendJson(res, 200, {
        ok: true,
        alreadyReady: result.alreadyReady,
        message: result.alreadyReady ? "PR already ready for review" : "Marked PR ready for review",
      });
      return true;
    }
    if (target.action === "retarget") {
      const body = await readJsonBody(req);
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
      return true;
    }
    if (target.action === "merge-auto") {
      const result = await enableMergeWhenReady(target.repo, target.prNumber);
      sendJson(res, 200, {
        ok: true,
        alreadyEnabled: result.alreadyEnabled,
        message: result.alreadyEnabled ? "Merge when ready already enabled" : "Merge when ready enabled",
      });
      return true;
    }
  }

  return false;
}
