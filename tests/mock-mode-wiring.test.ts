import test from "node:test";
import assert from "node:assert/strict";
import { setApiProvider, resetApiProvider } from "../lib/api-provider.js";
import { MockApiProvider } from "../lib/mock-api-provider.js";
import { fetchPRsWithStatus, invalidateStatusCache } from "../lib/services/status-service.js";
import { markPullRequestReady, retargetPullRequest, enableMergeWhenReady, rerunFailedWorkflowRuns, postPullRequestReply } from "../lib/services/status-actions.js";
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

test("Claude mock provider: reply routes through Claude API when agent is claude", async () => {
  const repo = "acme/claude-test";
  const mock = new MockApiProvider();
  mock.currentUser = "alice";
  mock.originRepo = repo;
  mock.config = { repos: [repo], claudeApiKey: "sk-ant-mock" };
  mock.addRepo(repo, { defaultBranch: "main" });
  mock.addBranch(repo, "claude/feature-x", { message: "X", authorLogin: "alice" });
  mock.addPR(repo, {
    number: 5,
    headRefName: "claude/feature-x",
    baseRefName: "main",
    title: "Feature X",
  });
  mock.addReviewComment(repo, 5, { body: "Fix this", id: 100 });

  // Pre-populate a Claude agent so follow-up is used
  const prUrl = `https://github.com/${repo}/pull/5`;
  mock.addClaudeAgent(prUrl, { id: "claude-agent-99" });

  setApiProvider(mock);
  invalidateStatusCache();
  try {
    const result = await postPullRequestReply({
      repo,
      prNumber: 5,
      inReplyToId: 100,
      body: "please address this",
      claudeApiKey: "sk-ant-mock",
      agent: "claude",
    });

    assert.equal(result.mode, "claude-followup");
    assert.ok(mock.claudeFollowups.get("claude-agent-99")?.includes("please address this"));
  } finally {
    resetApiProvider();
    invalidateStatusCache();
  }
});

test("Claude mock provider: reply launches new agent when no existing Claude agent", async () => {
  const repo = "acme/claude-test2";
  const mock = new MockApiProvider();
  mock.currentUser = "alice";
  mock.originRepo = repo;
  mock.config = { repos: [repo], claudeApiKey: "sk-ant-mock" };
  mock.addRepo(repo, { defaultBranch: "main" });
  mock.addBranch(repo, "claude/feature-y", { message: "Y", authorLogin: "alice" });
  mock.addPR(repo, {
    number: 6,
    headRefName: "claude/feature-y",
    baseRefName: "main",
    title: "Feature Y",
  });

  setApiProvider(mock);
  invalidateStatusCache();
  try {
    const result = await postPullRequestReply({
      repo,
      prNumber: 6,
      inReplyToId: 200,
      body: "build this feature",
      claudeApiKey: "sk-ant-mock",
      agent: "claude",
    });

    assert.equal(result.mode, "claude-launch");
    const prUrl = `https://github.com/${repo}/pull/6`;
    assert.ok(mock.claudeLaunches.get(prUrl)?.includes("build this feature"));
  } finally {
    resetApiProvider();
    invalidateStatusCache();
  }
});

test("status + actions with Claude PRs run through mock provider", async () => {
  const repo = "acme/claude-status";
  const mock = new MockApiProvider();
  mock.currentUser = "alice";
  mock.originRepo = repo;
  mock.config = { repos: [repo], claudeApiKey: "sk-ant-mock" };
  mock.addRepo(repo, { defaultBranch: "main" });
  mock.addBranch(repo, "claude/stack-b", { message: "B", authorLogin: "alice" });
  mock.addPR(repo, {
    number: 2,
    headRefName: "claude/stack-b",
    baseRefName: "main",
    title: "Stack B",
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
  });
  mock.addWorkflowRun(repo, "claude/stack-b", {
    databaseId: 43,
    name: "CI",
    conclusion: "failure",
    status: "completed",
    displayTitle: "CI",
  });

  setApiProvider(mock);
  invalidateStatusCache();
  try {
    const rows = await fetchPRsWithStatus({ repos: [repo], scope: "all" });
    const prRow = rows.find((row) => row.rowType === "pr" && row.repo === repo && row.number === 2);
    assert.ok(prRow);
    assert.equal(prRow.ciStatus, "fail");
    assert.equal(prRow.agent, "claude");

    const ready = await markPullRequestReady(repo, 2);
    assert.equal(ready.markedReady, true);

    const rerun = await rerunFailedWorkflowRuns(repo, "claude/stack-b");
    assert.equal(rerun.total, 1);
    assert.equal(mock.workflowRuns.get(`${repo}:claude/stack-b`)?.[0].status, "queued");
  } finally {
    resetApiProvider();
    invalidateStatusCache();
  }
});
