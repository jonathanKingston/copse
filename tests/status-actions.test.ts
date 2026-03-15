import test from "node:test";
import assert from "node:assert/strict";
import { chainMergePRs, createPullRequestForBranch, getIssueTemplateComment, markPullRequestReady } from "../lib/services/status-actions.js";

test("getIssueTemplateComment returns null for no-comment choice", () => {
  assert.equal(getIssueTemplateComment("cursor", 0), null);
});

test("getIssueTemplateComment prefixes template with selected agent mention", () => {
  const cursorText = getIssueTemplateComment("cursor", 1) || "";
  const claudeText = getIssueTemplateComment("claude", 2) || "";
  assert.ok(cursorText.startsWith("@cursor"));
  assert.ok(claudeText.startsWith("@claude"));
});

test("getIssueTemplateComment throws on invalid agent", () => {
  assert.throws(() => getIssueTemplateComment("unknown-agent", 1), /agent must be/);
});

test("markPullRequestReady marks draft PRs ready for review", async () => {
  const calls: string[][] = [];
  const deps = {
    ghQuietAsync: async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") return "true\n";
      return "";
    },
    addPRCommentAsync: async () => {},
    getCommitInfoAsync: async () => ({ message: "Title\n\nBody", date: new Date("2026-03-15T00:00:00Z"), authorLogin: "alice" }),
    getDefaultBranchAsync: async () => "main",
    invalidateStatusCache: () => {},
  };

  const result = await markPullRequestReady("acme/repo", 42, deps);

  assert.deepEqual(calls, [
    ["pr", "view", "42", "--repo", "acme/repo", "--json", "isDraft", "-q", ".isDraft"],
    ["pr", "ready", "42", "--repo", "acme/repo"],
  ]);
  assert.deepEqual(result, { markedReady: true, alreadyReady: false });
});

test("markPullRequestReady is a no-op for non-draft PRs", async () => {
  const calls: string[][] = [];
  const deps = {
    ghQuietAsync: async (...args: string[]) => {
      calls.push(args);
      return "false\n";
    },
    addPRCommentAsync: async () => {},
    getCommitInfoAsync: async () => ({ message: "Title", date: new Date("2026-03-15T00:00:00Z"), authorLogin: "alice" }),
    getDefaultBranchAsync: async () => "main",
    invalidateStatusCache: () => {},
  };

  const result = await markPullRequestReady("acme/repo", 42, deps);

  assert.deepEqual(calls, [
    ["pr", "view", "42", "--repo", "acme/repo", "--json", "isDraft", "-q", ".isDraft"],
  ]);
  assert.deepEqual(result, { markedReady: false, alreadyReady: true });
});

test("chainMergePRs retargets each PR and enables auto-merge in order", async () => {
  const calls: string[][] = [];
  const deps = {
    ghQuietAsync: async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args[2] === "10") return "main\n";
      if (args[0] === "pr" && args[1] === "view" && args[2] === "11") return "main\n";
      if (args[0] === "api" && args[1] === "repos/acme/repo") {
        return JSON.stringify({
          allowSquashMerge: true,
          allowMergeCommit: true,
          allowRebaseMerge: true,
        });
      }
      return "";
    },
    addPRCommentAsync: async () => {},
    getCommitInfoAsync: async () => ({ message: "Title", date: new Date("2026-03-15T00:00:00Z"), authorLogin: "alice" }),
    getDefaultBranchAsync: async () => "main",
    invalidateStatusCache: () => {},
  };

  const result = await chainMergePRs("acme/repo", [
    { number: 10, headRefName: "stack/a" },
    { number: 11, headRefName: "stack/b" },
    { number: 12, headRefName: "stack/c" },
  ], "main", deps);

  assert.deepEqual(calls, [
    ["pr", "view", "10", "--repo", "acme/repo", "--json", "baseRefName", "-q", ".baseRefName"],
    ["pr", "edit", "10", "--repo", "acme/repo", "--base", "stack/b"],
    ["pr", "view", "11", "--repo", "acme/repo", "--json", "baseRefName", "-q", ".baseRefName"],
    ["pr", "edit", "11", "--repo", "acme/repo", "--base", "stack/c"],
    ["api", "repos/acme/repo", "-q", "{allowSquashMerge: .allow_squash_merge, allowMergeCommit: .allow_merge_commit, allowRebaseMerge: .allow_rebase_merge}"],
    ["pr", "merge", "--repo", "acme/repo", "10", "--auto", "--squash"],
    ["pr", "merge", "--repo", "acme/repo", "11", "--auto", "--squash"],
    ["pr", "merge", "--repo", "acme/repo", "12", "--auto", "--squash"],
  ]);
  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(result.steps, [
    { action: "retarget", prNumber: 10, intoPR: 11, success: true, closedRedundant: false },
    { action: "retarget", prNumber: 11, intoPR: 12, success: true, closedRedundant: false },
    { action: "auto-merge", prNumber: 10, intoPR: 11, success: true, alreadyEnabled: false },
    { action: "auto-merge", prNumber: 11, intoPR: 12, success: true, alreadyEnabled: false },
    { action: "auto-merge", prNumber: 12, intoPR: "default", success: true, alreadyEnabled: false },
  ]);
});

test("chainMergePRs stops immediately when retargeting fails", async () => {
  const calls: string[][] = [];
  const deps = {
    ghQuietAsync: async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args[2] === "10") return "main\n";
      if (args[0] === "pr" && args[1] === "view" && args[2] === "11") return "main\n";
      if (args[0] === "pr" && args[1] === "edit" && args[2] === "11") {
        const error = new Error("boom") as Error & { stderr?: string };
        error.stderr = "cannot retarget";
        throw error;
      }
      return "";
    },
    addPRCommentAsync: async () => {},
    getCommitInfoAsync: async () => ({ message: "Title", date: new Date("2026-03-15T00:00:00Z"), authorLogin: "alice" }),
    getDefaultBranchAsync: async () => "main",
    invalidateStatusCache: () => {},
  };

  const result = await chainMergePRs("acme/repo", [
    { number: 10, headRefName: "stack/a" },
    { number: 11, headRefName: "stack/b" },
    { number: 12, headRefName: "stack/c" },
  ], "main", deps);

  assert.deepEqual(calls, [
    ["pr", "view", "10", "--repo", "acme/repo", "--json", "baseRefName", "-q", ".baseRefName"],
    ["pr", "edit", "10", "--repo", "acme/repo", "--base", "stack/b"],
    ["pr", "view", "11", "--repo", "acme/repo", "--json", "baseRefName", "-q", ".baseRefName"],
    ["pr", "edit", "11", "--repo", "acme/repo", "--base", "stack/c"],
  ]);
  assert.equal(result.stoppedEarly, true);
  assert.deepEqual(result.steps, [
    { action: "retarget", prNumber: 10, intoPR: 11, success: true, closedRedundant: false },
    { action: "retarget", prNumber: 11, intoPR: 12, success: false, error: "cannot retarget" },
  ]);
});

test("chainMergePRs closes redundant PRs and continues queueing", async () => {
  const calls: string[][] = [];
  const comments: Array<{ repo: string; prNumber: number; body: string }> = [];
  const repo = "acme/repo-redundant";
  const deps = {
    ghQuietAsync: async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args[2] === "10") return "main\n";
      if (args[0] === "pr" && args[1] === "view" && args[2] === "11") return "main\n";
      if (args[0] === "api" && args[1] === `repos/${repo}`) {
        return JSON.stringify({
          allowSquashMerge: true,
          allowMergeCommit: true,
          allowRebaseMerge: true,
        });
      }
      if (args[0] === "pr" && args[1] === "edit" && args[2] === "10") {
        const error = new Error("boom") as Error & { stderr?: string };
        error.stderr = "GraphQL: There are no new commits between base branch 'stack/b' and head branch 'stack/a' (updatePullRequest)";
        throw error;
      }
      return "";
    },
    addPRCommentAsync: async (commentRepo: string, prNumber: number, body: string) => {
      comments.push({ repo: commentRepo, prNumber, body });
    },
    getCommitInfoAsync: async () => ({ message: "Title", date: new Date("2026-03-15T00:00:00Z"), authorLogin: "alice" }),
    getDefaultBranchAsync: async () => "main",
    invalidateStatusCache: () => {},
  };

  const result = await chainMergePRs(repo, [
    { number: 10, headRefName: "stack/a" },
    { number: 11, headRefName: "stack/b" },
    { number: 12, headRefName: "stack/c" },
  ], "main", deps);

  assert.deepEqual(comments, [{
    repo,
    prNumber: 10,
    body: "Closing this PR because retargeting it onto `stack/b` showed there are no commits unique to this branch beyond that base.\n\nThis PR is redundant in the current stack, so the queue will continue without it.",
  }]);
  assert.deepEqual(calls, [
    ["pr", "view", "10", "--repo", repo, "--json", "baseRefName", "-q", ".baseRefName"],
    ["pr", "edit", "10", "--repo", repo, "--base", "stack/b"],
    ["pr", "close", "10", "--repo", repo],
    ["pr", "view", "11", "--repo", repo, "--json", "baseRefName", "-q", ".baseRefName"],
    ["pr", "edit", "11", "--repo", repo, "--base", "stack/c"],
    ["api", `repos/${repo}`, "-q", "{allowSquashMerge: .allow_squash_merge, allowMergeCommit: .allow_merge_commit, allowRebaseMerge: .allow_rebase_merge}"],
    ["pr", "merge", "--repo", repo, "11", "--auto", "--squash"],
    ["pr", "merge", "--repo", repo, "12", "--auto", "--squash"],
  ]);
  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(result.steps, [
    { action: "retarget", prNumber: 10, intoPR: 11, success: true, closedRedundant: true },
    { action: "retarget", prNumber: 11, intoPR: 12, success: true, closedRedundant: false },
    { action: "auto-merge", prNumber: 10, intoPR: 11, success: true, skipped: true },
    { action: "auto-merge", prNumber: 11, intoPR: 12, success: true, alreadyEnabled: false },
    { action: "auto-merge", prNumber: 12, intoPR: "default", success: true, alreadyEnabled: false },
  ]);
});

test("createPullRequestForBranch uses latest commit title and repo default branch", async () => {
  const calls: string[][] = [];
  let invalidated = 0;
  const result = await createPullRequestForBranch("acme/repo", "cursor/feature", {
    ghQuietAsync: async (...args: string[]) => {
      calls.push(args);
      return "https://github.com/acme/repo/pull/123\n";
    },
    addPRCommentAsync: async () => {},
    getCommitInfoAsync: async () => ({
      message: "Add dashboard branches\n\nImplements orphan branch rows.",
      date: new Date("2026-03-15T00:00:00Z"),
      authorLogin: "alice",
    }),
    getDefaultBranchAsync: async () => "main",
    invalidateStatusCache: () => {
      invalidated++;
    },
  });

  assert.deepEqual(calls, [[
    "pr", "create",
    "--repo", "acme/repo",
    "--base", "main",
    "--head", "cursor/feature",
    "--title", "Add dashboard branches",
    "--body", "Implements orphan branch rows.",
  ]]);
  assert.equal(invalidated, 1);
  assert.deepEqual(result, {
    title: "Add dashboard branches",
    body: "Implements orphan branch rows.",
    baseBranch: "main",
    url: "https://github.com/acme/repo/pull/123",
  });
});
