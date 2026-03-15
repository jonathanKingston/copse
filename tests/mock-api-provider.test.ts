import test from "node:test";
import assert from "node:assert/strict";

import { MockApiProvider } from "../lib/mock-api-provider.js";
import { setApiProvider, resetApiProvider, getApiProvider } from "../lib/api-provider.js";

test("MockApiProvider can be set and retrieved as active provider", () => {
  const mock = new MockApiProvider();
  setApiProvider(mock);
  assert.equal(getApiProvider(), mock);
  resetApiProvider();
  assert.equal(getApiProvider(), null);
});

test("MockApiProvider.reset clears all state", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  mock.addBranch("owner/repo", "cursor/fix");
  mock.addPR("owner/repo", { headRefName: "cursor/fix" });
  mock.addWorkflowRun("owner/repo", "cursor/fix", { name: "CI" });
  mock.currentUser = "other-user";

  mock.reset();

  assert.equal(mock.repos.size, 0);
  assert.equal(mock.branches.size, 0);
  assert.equal(mock.prs.size, 0);
  assert.equal(mock.workflowRuns.size, 0);
  assert.equal(mock.currentUser, "test-user");
});

test("MockApiProvider.addRepo creates repo with defaults", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  const repo = mock.repos.get("owner/repo");
  assert.ok(repo);
  assert.equal(repo.defaultBranch, "main");
  assert.equal(repo.allowSquashMerge, true);
});

test("MockApiProvider.addRepo accepts custom options", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo", { defaultBranch: "develop", allowSquashMerge: false });

  const repo = mock.repos.get("owner/repo");
  assert.equal(repo?.defaultBranch, "develop");
  assert.equal(repo?.allowSquashMerge, false);
});

test("MockApiProvider.addPR creates PR with auto-incrementing number", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  const pr1 = mock.addPR("owner/repo", { headRefName: "cursor/fix-1" });
  const pr2 = mock.addPR("owner/repo", { headRefName: "cursor/fix-2" });

  assert.ok(pr2.number > pr1.number);
  assert.equal(mock.prs.get("owner/repo")?.length, 2);
});

test("MockApiProvider.addPR auto-creates branch", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  mock.addPR("owner/repo", { headRefName: "cursor/feature" });

  const branches = mock.branches.get("owner/repo");
  assert.ok(branches?.includes("cursor/feature"));
});

test("MockApiProvider.listOpenPRs only returns open PRs", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  mock.addPR("owner/repo", { headRefName: "open-pr", state: "open" });
  mock.addPR("owner/repo", { headRefName: "closed-pr", state: "closed" });
  mock.addPR("owner/repo", { headRefName: "merged-pr", state: "merged" });

  const openPRs = mock.listOpenPRs("owner/repo");
  assert.equal(openPRs.length, 1);
  assert.equal(openPRs[0].headRefName, "open-pr");
});

test("MockApiProvider.addWorkflowRun stores runs by repo:branch key", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  mock.addWorkflowRun("owner/repo", "cursor/fix", { name: "CI", conclusion: "failure" });
  mock.addWorkflowRun("owner/repo", "cursor/fix", { name: "Lint", conclusion: "success" });

  const runs = mock.listWorkflowRuns("owner/repo", "cursor/fix");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].name, "CI");
  assert.equal(runs[0].conclusion, "failure");
  assert.equal(runs[1].name, "Lint");
});

test("MockApiProvider.getCommitInfo returns stored commit info", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  mock.addBranch("owner/repo", "cursor/fix", {
    message: "Fix the bug",
    authorLogin: "alice",
    date: new Date("2026-01-01"),
  });

  const info = mock.getCommitInfo("owner/repo", "cursor/fix", true);
  assert.equal(info.message, "Fix the bug");
  assert.equal(info.authorLogin, "alice");
});

test("MockApiProvider.getCommitInfo omits message when not requested", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  mock.addBranch("owner/repo", "main", { message: "Init", authorLogin: "bob" });

  const info = mock.getCommitInfo("owner/repo", "main", false);
  assert.equal(info.message, undefined);
  assert.equal(info.authorLogin, "bob");
});

test("MockApiProvider gh pr ready marks PR as non-draft", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  const pr = mock.addPR("owner/repo", { headRefName: "cursor/fix", isDraft: true });

  assert.equal(pr.isDraft, true);
  mock.gh("pr", "ready", String(pr.number), "--repo", "owner/repo");
  assert.equal(pr.isDraft, false);
});

test("MockApiProvider gh pr merge --auto enables auto-merge", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  const pr = mock.addPR("owner/repo", { headRefName: "cursor/fix" });

  assert.equal(pr.autoMergeRequest, null);
  mock.gh("pr", "merge", "--repo", "owner/repo", String(pr.number), "--auto", "--squash");
  assert.ok(pr.autoMergeRequest);
});

test("MockApiProvider gh pr close sets state to closed", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  const pr = mock.addPR("owner/repo", { headRefName: "cursor/fix" });

  mock.gh("pr", "close", String(pr.number), "--repo", "owner/repo");
  assert.equal(pr.state, "closed");
});

test("MockApiProvider gh pr edit --base retargets PR", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  const pr = mock.addPR("owner/repo", { headRefName: "cursor/fix", baseRefName: "main" });

  mock.gh("pr", "edit", String(pr.number), "--repo", "owner/repo", "--base", "develop");
  assert.equal(pr.baseRefName, "develop");
});

test("MockApiProvider gh pr create creates a new PR", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  const url = mock.gh("pr", "create", "--repo", "owner/repo", "--head", "cursor/new", "--base", "main", "--title", "New PR");
  assert.ok(url.includes("github.com/owner/repo/pull/"));
  assert.equal(mock.prs.get("owner/repo")?.length, 1);
});

test("MockApiProvider gh pr review --approve sets review decision", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  const pr = mock.addPR("owner/repo", { headRefName: "cursor/fix", reviewDecision: "REVIEW_REQUIRED" });

  mock.gh("pr", "review", "--repo", "owner/repo", String(pr.number), "--approve");
  assert.equal(pr.reviewDecision, "APPROVED");
});

test("MockApiProvider gh run rerun resets run status", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  mock.addWorkflowRun("owner/repo", "cursor/fix", { name: "CI", databaseId: 42, conclusion: "failure", status: "completed" });

  mock.gh("run", "rerun", "42", "--repo", "owner/repo");

  const runs = mock.listWorkflowRuns("owner/repo", "cursor/fix");
  assert.equal(runs[0].conclusion, "");
  assert.equal(runs[0].status, "queued");
});

test("MockApiProvider tracks all gh calls", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");
  mock.addPR("owner/repo", { headRefName: "cursor/fix", number: 1 });

  mock.gh("pr", "view", "1", "--repo", "owner/repo");
  mock.ghQuiet("pr", "list", "--repo", "owner/repo");

  assert.equal(mock.ghCalls.length, 2);
  assert.deepEqual(mock.ghCalls[0], ["pr", "view", "1", "--repo", "owner/repo"]);
});

test("MockApiProvider addReviewComment creates and lists comments", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  mock.addReviewComment("owner/repo", 1, { body: "Fix this line" });
  mock.addReviewComment("owner/repo", 1, { body: "Also this" });

  const comments = mock.listPRReviewComments("owner/repo", 1);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, "Fix this line");
});

test("MockApiProvider resolved review threads filter out comments", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  const comment = mock.addReviewComment("owner/repo", 1, { body: "Fix this" });
  mock.reviewThreads.set("owner/repo:1", [
    { id: "thread-1", isResolved: true, commentNodeIds: [comment.node_id] },
  ]);

  const comments = mock.listPRReviewComments("owner/repo", 1);
  assert.equal(comments.length, 0);
});

test("MockApiProvider addPRCommentAsync stores comments", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  await mock.addPRCommentAsync("owner/repo", 1, "Looks good!");
  await mock.addPRCommentAsync("owner/repo", 1, "LGTM");

  const comments = mock.prComments.get("owner/repo:1");
  assert.deepEqual(comments, ["Looks good!", "LGTM"]);
});

test("MockApiProvider replyToPRCommentAsync stores replies", async () => {
  const mock = new MockApiProvider();
  await mock.replyToPRCommentAsync("owner/repo", 1, 100, "Thanks for the feedback");

  const replies = mock.prReplies.get("owner/repo:1:100");
  assert.deepEqual(replies, ["Thanks for the feedback"]);
});

test("MockApiProvider Cursor agent lifecycle", async () => {
  const mock = new MockApiProvider();
  const prUrl = "https://github.com/owner/repo/pull/1";

  // No agents initially
  const agents = await mock.cursorListAgentsByPrUrl("key", prUrl);
  assert.equal(agents.length, 0);

  // Add an agent
  mock.addCursorAgent(prUrl, { status: "running" });
  const found = await mock.cursorFindLatestAgentByPrUrl("key", prUrl);
  assert.ok(found);
  assert.equal(found.status, "running");

  // Follow up
  await mock.cursorAddFollowup("key", found.id, "fix the tests too");
  assert.deepEqual(mock.cursorFollowups.get(found.id), ["fix the tests too"]);

  // Launch new agent
  const newId = await mock.cursorLaunchAgentForPrUrl("key", prUrl, "new task");
  assert.ok(newId);
  assert.deepEqual(mock.cursorLaunches.get(prUrl), ["new task"]);
});

test("MockApiProvider Claude agent lifecycle", async () => {
  const mock = new MockApiProvider();
  const prUrl = "https://github.com/owner/repo/pull/2";

  const agents = await mock.claudeListAgentsByPrUrl("key", prUrl);
  assert.equal(agents.length, 0);

  mock.addClaudeAgent(prUrl, { status: "completed" });
  const found = await mock.claudeFindLatestAgentByPrUrl("key", prUrl);
  assert.ok(found);
  assert.equal(found.status, "completed");

  await mock.claudeAddFollowup("key", found.id, "add documentation");
  assert.deepEqual(mock.claudeFollowups.get(found.id), ["add documentation"]);

  const newId = await mock.claudeLaunchAgentForPrUrl("key", prUrl, "new task");
  assert.ok(newId);
  assert.ok(newId.startsWith("claude-agent-"));
});

test("MockApiProvider config and templates", () => {
  const mock = new MockApiProvider();

  assert.equal(mock.loadConfig(), null);
  assert.equal(mock.getConfiguredRepos(), null);

  mock.config = { repos: ["owner/repo1", "owner/repo2"] };
  assert.deepEqual(mock.getConfiguredRepos(), ["owner/repo1", "owner/repo2"]);

  const templates = new Map([["fix", "Fix this"]]);
  mock.templates.set("/path", templates);
  assert.equal(mock.loadTemplates("/path")?.get("fix"), "Fix this");
});

test("MockApiProvider invalidateStatusCache increments counter", () => {
  const mock = new MockApiProvider();
  assert.equal(mock.statusCacheInvalidations, 0);
  mock.invalidateStatusCache();
  mock.invalidateStatusCache();
  assert.equal(mock.statusCacheInvalidations, 2);
});

test("MockApiProvider listPRFiles returns stored files", () => {
  const mock = new MockApiProvider();
  mock.prFiles.set("owner/repo:1", [
    { sha: "abc123", filename: "src/index.ts", status: "modified", additions: 10, deletions: 2, changes: 12 },
  ]);

  const files = mock.listPRFiles("owner/repo", 1);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "src/index.ts");
});

test("MockApiProvider getDefaultBranchAsync returns repo default branch", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo", { defaultBranch: "develop" });

  const branch = await mock.getDefaultBranchAsync("owner/repo");
  assert.equal(branch, "develop");
});

test("MockApiProvider getDefaultBranchAsync throws for unknown repo", async () => {
  const mock = new MockApiProvider();
  await assert.rejects(() => mock.getDefaultBranchAsync("unknown/repo"), /unknown repo/);
});

test("MockApiProvider gh issue create returns issue URL", () => {
  const mock = new MockApiProvider();
  mock.addRepo("owner/repo");

  const url = mock.gh("issue", "create", "--repo", "owner/repo", "--title", "Bug");
  assert.ok(url.includes("github.com/owner/repo/issues/"));
});

test("MockApiProvider originRepo getter", () => {
  const mock = new MockApiProvider();
  assert.equal(mock.getOriginRepo(), null);
  mock.originRepo = "owner/repo";
  assert.equal(mock.getOriginRepo(), "owner/repo");
});
