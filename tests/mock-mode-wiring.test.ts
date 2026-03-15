import test from "node:test";
import assert from "node:assert/strict";
import { setApiProvider, resetApiProvider } from "../lib/api-provider.js";
import { MockApiProvider } from "../lib/mock-api-provider.js";
import { fetchPRsWithStatus, invalidateStatusCache } from "../lib/services/status-service.js";
import { markPullRequestReady, retargetPullRequest, enableMergeWhenReady, rerunFailedWorkflowRuns } from "../lib/services/status-actions.js";
import { getCurrentUser, getCommitInfoBatch, getCommitInfoBatchAsync } from "../lib/gh.js";

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

test("getCommitInfoBatch delegates to mock provider", () => {
  const repo = "acme/batch-test";
  const mock = new MockApiProvider();
  mock.addRepo(repo, { defaultBranch: "main" });
  mock.addBranch(repo, "cursor/feat-a", { message: "Feature A", authorLogin: "alice", date: new Date("2026-03-10T10:00:00Z") });
  mock.addBranch(repo, "claude/feat-b", { message: "Feature B", authorLogin: "bob", date: new Date("2026-03-11T10:00:00Z") });

  setApiProvider(mock);
  try {
    const result = getCommitInfoBatch(repo, ["cursor/feat-a", "claude/feat-b"], true);
    assert.equal(result.size, 2);

    const infoA = result.get("cursor/feat-a");
    assert.ok(infoA);
    assert.equal(infoA.message, "Feature A");
    assert.equal(infoA.authorLogin, "alice");

    const infoB = result.get("claude/feat-b");
    assert.ok(infoB);
    assert.equal(infoB.message, "Feature B");
    assert.equal(infoB.authorLogin, "bob");
  } finally {
    resetApiProvider();
  }
});

test("getCommitInfoBatchAsync delegates to mock provider", async () => {
  const repo = "acme/batch-async-test";
  const mock = new MockApiProvider();
  mock.addRepo(repo, { defaultBranch: "main" });
  mock.addBranch(repo, "cursor/async-a", { message: "Async A", authorLogin: "carol", date: new Date("2026-03-12T10:00:00Z") });

  setApiProvider(mock);
  try {
    const result = await getCommitInfoBatchAsync(repo, ["cursor/async-a"], true);
    assert.equal(result.size, 1);

    const info = result.get("cursor/async-a");
    assert.ok(info);
    assert.equal(info.message, "Async A");
    assert.equal(info.authorLogin, "carol");
  } finally {
    resetApiProvider();
  }
});

test("standalone branches appear via mock provider with batched commit info", async () => {
  const repo = "acme/standalone-test";
  const mock = new MockApiProvider();
  mock.currentUser = "alice";
  mock.originRepo = repo;
  mock.config = { repos: [repo], cursorApiKey: "cur_mock" };
  mock.addRepo(repo, { defaultBranch: "main" });
  mock.addBranch(repo, "cursor/has-pr", { message: "Has PR", authorLogin: "alice", date: new Date("2026-03-10T10:00:00Z") });
  mock.addBranch(repo, "cursor/standalone", { message: "Standalone work", authorLogin: "alice", date: new Date("2026-03-11T10:00:00Z") });
  mock.addPR(repo, {
    number: 1,
    headRefName: "cursor/has-pr",
    baseRefName: "main",
    title: "Has PR",
    isDraft: false,
    reviewDecision: "APPROVED",
  });

  setApiProvider(mock);
  invalidateStatusCache();
  try {
    const rows = await fetchPRsWithStatus({ repos: [repo], scope: "all" });
    const branchRow = rows.find((row) => row.rowType === "branch" && row.headRefName === "cursor/standalone");
    assert.ok(branchRow, "standalone branch should appear in status rows");
    assert.equal(branchRow.title, "Standalone work");
  } finally {
    resetApiProvider();
    invalidateStatusCache();
  }
});
