import test from "node:test";
import assert from "node:assert/strict";
import { setApiProvider, resetApiProvider } from "../lib/api-provider.js";
import { MockApiProvider } from "../lib/mock-api-provider.js";
import { fetchPRsWithStatus, invalidateStatusCache } from "../lib/services/status-service.js";
import { markPullRequestReady, retargetPullRequest, enableMergeWhenReady, rerunFailedWorkflowRuns } from "../lib/services/status-actions.js";
import { getCurrentUser } from "../lib/gh.js";

test("status + actions run through mock provider", async () => {
  const repo = "acme/mock-provider";
  const mock = new MockApiProvider();
  mock.currentUser = "alice";
  mock.originRepo = repo;
  mock.config = { repos: [repo], cursorApiKey: "cur_mock" };
  mock.addRepo(repo, { defaultBranch: "main" });
  mock.addBranch(repo, "cursor/stack-a", { message: "A", authorLogin: "alice" });
  mock.addPR(repo, {
    number: 1,
    headRefName: "cursor/stack-a",
    baseRefName: "main",
    title: "Stack A",
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
  });
  mock.addWorkflowRun(repo, "cursor/stack-a", {
    databaseId: 42,
    name: "CI",
    conclusion: "failure",
    status: "completed",
    displayTitle: "CI",
  });

  setApiProvider(mock);
  invalidateStatusCache();
  try {
    assert.equal(getCurrentUser(), "alice");

    const rows = await fetchPRsWithStatus({ repos: [repo], scope: "all" });
    const prRow = rows.find((row) => row.rowType === "pr" && row.repo === repo && row.number === 1);
    assert.ok(prRow);
    assert.equal(prRow.ciStatus, "fail");

    const ready = await markPullRequestReady(repo, 1);
    assert.equal(ready.markedReady, true);
    assert.equal(mock.prs.get(repo)?.[0].isDraft, false);

    const retarget = await retargetPullRequest(repo, 1, "main");
    assert.equal(retarget.alreadyTargeted, true);

    const merge = await enableMergeWhenReady(repo, 1);
    assert.equal(merge.enabled, true);
    assert.ok(mock.prs.get(repo)?.[0].autoMergeRequest);

    const rerun = await rerunFailedWorkflowRuns(repo, "cursor/stack-a");
    assert.equal(rerun.total, 1);
    assert.equal(mock.workflowRuns.get(`${repo}:cursor/stack-a`)?.[0].status, "queued");
    assert.equal(mock.workflowRuns.get(`${repo}:cursor/stack-a`)?.[0].conclusion, "");
  } finally {
    resetApiProvider();
    invalidateStatusCache();
  }
});
