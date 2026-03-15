import test from "node:test";
import assert from "node:assert/strict";
import { MockApiProvider } from "../lib/mock-api-provider.js";
import { getProvider, setProvider, resetProvider } from "../lib/api-provider.js";

// ─── Provider registry ─────────────────────────────────────────────────────

test("setProvider / getProvider / resetProvider lifecycle", () => {
  const mock = new MockApiProvider();
  mock.currentUser = "alice";
  setProvider(mock);
  const provider = getProvider();
  assert.equal(provider.getCurrentUser(), "alice");
  resetProvider();
});

// ─── Reset ──────────────────────────────────────────────────────────────────

test("reset() clears all state", () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { headRefName: "cursor/fix" });
  mock.addWorkflowRun("acme/app", "cursor/fix", { name: "CI" });
  mock.currentUser = "bob";
  mock.config = { repos: ["acme/app"] };

  mock.reset();

  assert.equal(mock.currentUser, "test-user");
  assert.equal(mock.repos.size, 0);
  assert.equal(mock.prs.size, 0);
  assert.equal(mock.workflowRuns.size, 0);
  assert.equal(mock.config, null);
});

// ─── Repos & branches ───────────────────────────────────────────────────────

test("addRepo sets up default branch and merge settings", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app", { defaultBranch: "develop" });

  assert.equal(await mock.getDefaultBranchAsync("acme/app"), "develop");
  assert.deepEqual(mock.listBranches("acme/app"), []);
});

test("addBranch adds branches and default commit info", () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addBranch("acme/app", "cursor/fix", { message: "fix bug", authorLogin: "alice" });

  assert.deepEqual(mock.listBranches("acme/app"), ["cursor/fix"]);
  const info = mock.getCommitInfo("acme/app", "cursor/fix", true);
  assert.equal(info.message, "fix bug");
  assert.equal(info.authorLogin, "alice");
});

// ─── PRs ────────────────────────────────────────────────────────────────────

test("addPR creates an open PR with default fields", () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  const pr = mock.addPR("acme/app", {
    headRefName: "claude/feature",
    title: "Add feature",
  });

  assert.equal(pr.title, "Add feature");
  assert.equal(pr.state, "open");
  assert.equal(pr.baseRefName, "main");

  const openPRs = mock.listOpenPRs("acme/app");
  assert.equal(openPRs.length, 1);
  assert.equal(openPRs[0].title, "Add feature");
});

test("listOpenPRs excludes closed and merged PRs", () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { headRefName: "a", state: "open" });
  mock.addPR("acme/app", { headRefName: "b", state: "closed" });
  mock.addPR("acme/app", { headRefName: "c", state: "merged" });

  assert.equal(mock.listOpenPRs("acme/app").length, 1);
});

// ─── Workflow runs ──────────────────────────────────────────────────────────

test("addWorkflowRun and listWorkflowRuns", () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addWorkflowRun("acme/app", "cursor/fix", { name: "CI", conclusion: "success" });
  mock.addWorkflowRun("acme/app", "cursor/fix", { name: "Lint", conclusion: "failure" });

  const runs = mock.listWorkflowRuns("acme/app", "cursor/fix");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].conclusion, "success");
  assert.equal(runs[1].conclusion, "failure");
});

// ─── Review comments ────────────────────────────────────────────────────────

test("addReviewComment and listPRReviewComments", () => {
  const mock = new MockApiProvider();
  mock.addReviewComment("acme/app", 1, { body: "Fix this" });
  mock.addReviewComment("acme/app", 1, { body: "Also this" });

  const comments = mock.listPRReviewComments("acme/app", 1);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, "Fix this");
});

test("resolved review threads filter out comments", () => {
  const mock = new MockApiProvider();
  const c1 = mock.addReviewComment("acme/app", 1, { body: "Resolved comment" });
  mock.addReviewComment("acme/app", 1, { body: "Open comment" });

  mock.reviewThreads.set("acme/app:1", [
    { id: "thread-1", isResolved: true, commentNodeIds: [c1.node_id] },
  ]);

  const unresolved = mock.listPRReviewComments("acme/app", 1);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].body, "Open comment");
});

test("getUnresolvedCommentCounts returns correct counts", () => {
  const mock = new MockApiProvider();
  mock.addReviewComment("acme/app", 1, { body: "A" });
  mock.addReviewComment("acme/app", 1, { body: "B" });
  mock.addReviewComment("acme/app", 2, { body: "C" });

  const counts = mock.getUnresolvedCommentCounts("acme/app", [1, 2, 3]);
  assert.equal(counts.get(1), 2);
  assert.equal(counts.get(2), 1);
  assert.equal(counts.get(3), 0);
});

// ─── PR mutations via addPRCommentAsync / replyToPRCommentAsync ─────────────

test("addPRCommentAsync stores comments", async () => {
  const mock = new MockApiProvider();
  await mock.addPRCommentAsync("acme/app", 1, "LGTM");
  await mock.addPRCommentAsync("acme/app", 1, "Ship it");

  assert.deepEqual(mock.prComments.get("acme/app:1"), ["LGTM", "Ship it"]);
});

test("replyToPRCommentAsync stores replies", async () => {
  const mock = new MockApiProvider();
  await mock.replyToPRCommentAsync("acme/app", 1, 42, "Fixed!");

  assert.deepEqual(mock.prReplies.get("acme/app:1:42"), ["Fixed!"]);
});

// ─── gh passthrough: PR view ────────────────────────────────────────────────

test("gh pr view returns isDraft", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { number: 5, headRefName: "feat", isDraft: true });

  const result = await mock.ghQuietAsync(
    "pr", "view", "5", "--repo", "acme/app", "--json", "isDraft", "-q", ".isDraft"
  );
  assert.equal(result.trim(), "true");
});

test("gh pr view returns baseRefName", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { number: 5, headRefName: "feat", baseRefName: "develop" });

  const result = await mock.ghQuietAsync(
    "pr", "view", "5", "--repo", "acme/app", "--json", "baseRefName", "-q", ".baseRefName"
  );
  assert.equal(result.trim(), "develop");
});

// ─── gh passthrough: PR edit (retarget) ──────────────────────────────────────

test("gh pr edit --base retargets a PR", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { number: 5, headRefName: "feat", baseRefName: "main" });

  await mock.ghQuietAsync("pr", "edit", "5", "--repo", "acme/app", "--base", "develop");

  const prs = mock.prs.get("acme/app")!;
  assert.equal(prs[0].baseRefName, "develop");
});

// ─── gh passthrough: PR merge (auto-merge) ───────────────────────────────────

test("gh pr merge --auto enables auto-merge", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { number: 5, headRefName: "feat" });

  await mock.ghQuietAsync("pr", "merge", "--repo", "acme/app", "5", "--auto", "--squash");

  const pr = mock.prs.get("acme/app")![0];
  assert.notEqual(pr.autoMergeRequest, null);
  assert.equal(pr.state, "open"); // auto-merge doesn't close immediately
});

// ─── gh passthrough: PR ready ────────────────────────────────────────────────

test("gh pr ready marks PR as non-draft", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { number: 5, headRefName: "feat", isDraft: true });

  await mock.ghQuietAsync("pr", "ready", "5", "--repo", "acme/app");

  assert.equal(mock.prs.get("acme/app")![0].isDraft, false);
});

// ─── gh passthrough: PR close ────────────────────────────────────────────────

test("gh pr close sets state to closed", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { number: 5, headRefName: "feat" });

  await mock.ghQuietAsync("pr", "close", "5", "--repo", "acme/app");

  assert.equal(mock.prs.get("acme/app")![0].state, "closed");
});

// ─── gh passthrough: PR create ───────────────────────────────────────────────

test("gh pr create adds a PR and returns URL", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");

  const url = await mock.ghQuietAsync(
    "pr", "create", "--repo", "acme/app", "--head", "cursor/fix", "--base", "main", "--title", "Fix bug"
  );

  assert.match(url, /https:\/\/github\.com\/acme\/app\/pull\/\d+/);
  const prs = mock.prs.get("acme/app")!;
  assert.equal(prs.length, 1);
  assert.equal(prs[0].title, "Fix bug");
});

// ─── gh passthrough: repo metadata ───────────────────────────────────────────

test("api repos/{repo} returns merge settings", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app", { allowSquashMerge: true, allowMergeCommit: false });

  const result = await mock.ghQuietAsync(
    "api", "repos/acme/app", "-q",
    "{allowSquashMerge: .allow_squash_merge, allowMergeCommit: .allow_merge_commit, allowRebaseMerge: .allow_rebase_merge}"
  );
  const parsed = JSON.parse(result);
  assert.equal(parsed.allowSquashMerge, true);
  assert.equal(parsed.allowMergeCommit, false);
});

// ─── gh passthrough: issue create ────────────────────────────────────────────

test("gh issue create returns issue URL", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");

  const url = await mock.ghQuietAsync(
    "issue", "create", "--repo", "acme/app", "--title", "Bug", "--body", "Details"
  );
  assert.match(url, /https:\/\/github\.com\/acme\/app\/issues\/\d+/);
});

// ─── gh passthrough: run list / rerun ────────────────────────────────────────

test("gh run list returns workflow runs", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addWorkflowRun("acme/app", "feat", { name: "CI", databaseId: 100, conclusion: "failure" });

  const result = await mock.ghQuietAsync(
    "run", "list", "--repo", "acme/app", "--branch", "feat", "--limit", "100",
    "--json", "databaseId,name,conclusion,attempt,status,displayTitle"
  );
  const runs = JSON.parse(result);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, "failure");
});

test("gh run rerun resets run status", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addWorkflowRun("acme/app", "feat", { name: "CI", databaseId: 100, conclusion: "failure" });

  await mock.ghQuietAsync("run", "rerun", "100", "--repo", "acme/app", "--failed");

  const runs = mock.workflowRuns.get("acme/app:feat")!;
  assert.equal(runs[0].status, "queued");
  assert.equal(runs[0].conclusion, "");
});

// ─── gh call logging ─────────────────────────────────────────────────────────

test("all gh calls are logged", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app");
  mock.addPR("acme/app", { number: 1, headRefName: "feat" });

  await mock.ghQuietAsync("pr", "view", "1", "--repo", "acme/app", "--json", "isDraft", "-q", ".isDraft");
  mock.gh("api", "user");

  assert.equal(mock.ghCalls.length, 2);
  assert.deepEqual(mock.ghCalls[0][0], "pr");
  assert.deepEqual(mock.ghCalls[1], ["api", "user"]);
});

// ─── Cursor API ─────────────────────────────────────────────────────────────

test("Cursor agent lifecycle: add, find, followup", async () => {
  const mock = new MockApiProvider();
  const prUrl = "https://github.com/acme/app/pull/1";
  const agent = mock.addCursorAgent(prUrl);

  const found = await mock.cursorFindLatestAgentByPrUrl("key", prUrl);
  assert.equal(found?.id, agent.id);

  const followupId = await mock.cursorAddFollowup("key", agent.id, "Please fix tests");
  assert.equal(followupId, agent.id);
  assert.deepEqual(mock.cursorFollowups.get(agent.id), ["Please fix tests"]);
});

test("cursorLaunchAgentForPrUrl creates a new agent", async () => {
  const mock = new MockApiProvider();
  const prUrl = "https://github.com/acme/app/pull/1";

  const agentId = await mock.cursorLaunchAgentForPrUrl("key", prUrl, "Build this");

  assert.ok(agentId.startsWith("agent-"));
  assert.deepEqual(mock.cursorLaunches.get(prUrl), ["Build this"]);
  const agents = await mock.cursorListAgentsByPrUrl("key", prUrl);
  assert.equal(agents.length, 1);
});

test("cursorFindLatestAgentByPrUrl returns most recent", async () => {
  const mock = new MockApiProvider();
  const prUrl = "https://github.com/acme/app/pull/1";
  mock.addCursorAgent(prUrl, { createdAt: "2026-01-01T00:00:00Z" });
  const newer = mock.addCursorAgent(prUrl, { createdAt: "2026-03-15T00:00:00Z" });

  const found = await mock.cursorFindLatestAgentByPrUrl("key", prUrl);
  assert.equal(found?.id, newer.id);
});

test("cursorListAgentArtifacts returns stored artifacts", async () => {
  const mock = new MockApiProvider();
  mock.cursorArtifacts.set("agent-1", [
    { absolutePath: "/src/fix.ts", sizeBytes: 1024 },
  ]);

  const artifacts = await mock.cursorListAgentArtifacts("key", "agent-1");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].absolutePath, "/src/fix.ts");
});

test("cursorGetArtifactDownloadUrl returns stored or generated URL", async () => {
  const mock = new MockApiProvider();
  mock.cursorDownloadUrls.set("agent-1:/src/fix.ts", { url: "https://custom.url/download" });

  const result1 = await mock.cursorGetArtifactDownloadUrl("key", "agent-1", "/src/fix.ts");
  assert.equal(result1.url, "https://custom.url/download");

  const result2 = await mock.cursorGetArtifactDownloadUrl("key", "agent-2", "/other.ts");
  assert.match(result2.url, /mock-download/);
});

// ─── Configuration ──────────────────────────────────────────────────────────

test("loadConfig returns mock config", () => {
  const mock = new MockApiProvider();
  assert.equal(mock.loadConfig(), null);

  mock.config = { repos: ["acme/app"], cursorApiKey: "cur_test" };
  assert.deepEqual(mock.loadConfig()?.repos, ["acme/app"]);
  assert.equal(mock.loadConfig()?.cursorApiKey, "cur_test");
});

test("getConfiguredRepos returns repos from config", () => {
  const mock = new MockApiProvider();
  assert.equal(mock.getConfiguredRepos(), null);

  mock.config = { repos: ["acme/app", "acme/lib"] };
  assert.deepEqual(mock.getConfiguredRepos(), ["acme/app", "acme/lib"]);
});

// ─── Git / templates ────────────────────────────────────────────────────────

test("getOriginRepo returns mock value", () => {
  const mock = new MockApiProvider();
  assert.equal(mock.getOriginRepo(), null);

  mock.originRepo = "acme/app";
  assert.equal(mock.getOriginRepo(), "acme/app");
});

test("loadTemplates returns mock templates", () => {
  const mock = new MockApiProvider();
  const templates = new Map([["fix", "Please fix this."]]);
  mock.templates.set("~/.copse/comment-templates", templates);

  const loaded = mock.loadTemplates("~/.copse/comment-templates");
  assert.equal(loaded.get("fix"), "Please fix this.");
  assert.equal(mock.loadTemplates("/other").size, 0);
});

// ─── Status cache invalidation tracking ──────────────────────────────────────

test("invalidateStatusCache increments counter", () => {
  const mock = new MockApiProvider();
  assert.equal(mock.statusCacheInvalidations, 0);
  mock.invalidateStatusCache();
  mock.invalidateStatusCache();
  assert.equal(mock.statusCacheInvalidations, 2);
});

// ─── Integration: mock works as StatusActionDeps via ghQuietAsync ────────────

test("mock can serve as a backend for status-actions chainMergePRs pattern", async () => {
  const mock = new MockApiProvider();
  mock.addRepo("acme/app", { allowSquashMerge: true });
  mock.addPR("acme/app", { number: 10, headRefName: "stack/a", baseRefName: "main" });
  mock.addPR("acme/app", { number: 11, headRefName: "stack/b", baseRefName: "main" });
  mock.addPR("acme/app", { number: 12, headRefName: "stack/c", baseRefName: "main" });

  setProvider(mock);
  const provider = getProvider();

  // Simulate the retarget + auto-merge flow that chainMergePRs does.
  // Step 1: View current base for PR 10.
  const base10 = await provider.ghQuietAsync(
    "pr", "view", "10", "--repo", "acme/app", "--json", "baseRefName", "-q", ".baseRefName"
  );
  assert.equal(base10.trim(), "main");

  // Step 2: Retarget PR 10 to stack/b.
  await provider.ghQuietAsync("pr", "edit", "10", "--repo", "acme/app", "--base", "stack/b");
  assert.equal(mock.prs.get("acme/app")![0].baseRefName, "stack/b");

  // Step 3: Enable auto-merge on PR 10.
  const repoMeta = await provider.ghQuietAsync(
    "api", "repos/acme/app", "-q",
    "{allowSquashMerge: .allow_squash_merge, allowMergeCommit: .allow_merge_commit, allowRebaseMerge: .allow_rebase_merge}"
  );
  assert.ok(JSON.parse(repoMeta).allowSquashMerge);
  await provider.ghQuietAsync("pr", "merge", "--repo", "acme/app", "10", "--auto", "--squash");
  assert.notEqual(mock.prs.get("acme/app")![0].autoMergeRequest, null);

  resetProvider();
});

// ─── ensureGh is a no-op ─────────────────────────────────────────────────────

test("ensureGh does not throw", () => {
  const mock = new MockApiProvider();
  assert.doesNotThrow(() => mock.ensureGh());
});
