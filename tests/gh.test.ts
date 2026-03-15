import test from "node:test";
import assert from "node:assert/strict";

import {
  REPO_PATTERN,
  validateRepo,
  validateAgent,
  matchesAgent,
  getAgentForPR,
  isBotPR,
  getBotAgent,
  formatGhError,
  mergeCommitMentionsBranch,
  GhNotFoundError,
  GhNotAuthenticatedError,
  AGENT_BRANCH_PATTERNS,
} from "../lib/gh.js";
import type { PR, ExecError } from "../lib/types.js";

function makePR(overrides: Partial<PR> = {}): PR {
  return {
    number: 1,
    headRefName: "feature/default",
    labels: [],
    title: "Default title",
    author: { login: "someone" },
    ...overrides,
  };
}

// -- validateRepo --

test("validateRepo accepts owner/name format", () => {
  assert.doesNotThrow(() => validateRepo("acme/cool-project"));
  assert.doesNotThrow(() => validateRepo("my-org/repo.name"));
  assert.doesNotThrow(() => validateRepo("user_1/repo_2"));
});

test("validateRepo rejects invalid formats", () => {
  assert.throws(() => validateRepo("noslash"), /Invalid repo/);
  assert.throws(() => validateRepo("too/many/slashes"), /Invalid repo/);
  assert.throws(() => validateRepo(""), /Invalid repo/);
  assert.throws(() => validateRepo("has spaces/repo"), /Invalid repo/);
});

test("REPO_PATTERN matches valid repos", () => {
  assert.ok(REPO_PATTERN.test("owner/repo"));
  assert.ok(REPO_PATTERN.test("my.org/my.repo"));
  assert.ok(!REPO_PATTERN.test("no-slash"));
});

// -- validateAgent --

test("validateAgent accepts known agents case-insensitively", () => {
  assert.equal(validateAgent("cursor"), "cursor");
  assert.equal(validateAgent("CLAUDE"), "claude");
  assert.equal(validateAgent("Copilot"), "copilot");
});

test("validateAgent rejects unknown agents", () => {
  assert.throws(() => validateAgent("unknown"), /agent must be/);
  assert.throws(() => validateAgent(""), /agent must be/);
});

// -- matchesAgent --

test("matchesAgent matches by branch name", () => {
  assert.ok(matchesAgent(makePR({ headRefName: "cursor/fix-bug" }), "cursor"));
  assert.ok(matchesAgent(makePR({ headRefName: "claude/add-feature" }), "claude"));
  assert.ok(matchesAgent(makePR({ headRefName: "copilot/refactor" }), "copilot"));
});

test("matchesAgent matches by label", () => {
  assert.ok(matchesAgent(makePR({ headRefName: "feature/x", labels: [{ name: "cursor-pr" }] }), "cursor"));
  assert.ok(matchesAgent(makePR({ headRefName: "feature/x", labels: [{ name: "claude" }] }), "claude"));
  assert.ok(matchesAgent(makePR({ headRefName: "feature/x", labels: [{ name: "copilot" }] }), "copilot"));
});

test("matchesAgent returns false for non-matching agent", () => {
  assert.ok(!matchesAgent(makePR({ headRefName: "feature/normal" }), "cursor"));
  assert.ok(!matchesAgent(makePR({ headRefName: "cursor/fix" }), "claude"));
});

test("matchesAgent with null agent matches any known agent", () => {
  assert.ok(matchesAgent(makePR({ headRefName: "cursor/fix" }), null));
  assert.ok(matchesAgent(makePR({ headRefName: "claude/fix" }), null));
  assert.ok(!matchesAgent(makePR({ headRefName: "feature/normal" }), null));
});

test("matchesAgent returns false for unknown agent pattern", () => {
  assert.ok(!matchesAgent(makePR({ headRefName: "cursor/fix" }), "unknown"));
});

// -- getAgentForPR --

test("getAgentForPR returns agent name for matching PRs", () => {
  assert.equal(getAgentForPR(makePR({ headRefName: "cursor/fix" })), "cursor");
  assert.equal(getAgentForPR(makePR({ headRefName: "claude/fix" })), "claude");
  assert.equal(getAgentForPR(makePR({ headRefName: "copilot/fix" })), "copilot");
});

test("getAgentForPR returns bot agent for dependabot", () => {
  assert.equal(getAgentForPR(makePR({ headRefName: "deps/bump", author: { login: "app/dependabot" } })), "depbot");
});

test("getAgentForPR returns null for non-agent PRs", () => {
  assert.equal(getAgentForPR(makePR({ headRefName: "feature/normal" })), null);
});

// -- isBotPR / getBotAgent --

test("isBotPR detects dependabot PRs", () => {
  assert.ok(isBotPR(makePR({ author: { login: "app/dependabot" } })));
  assert.ok(!isBotPR(makePR({ author: { login: "alice" } })));
});

test("getBotAgent returns agent key for bots", () => {
  assert.equal(getBotAgent(makePR({ author: { login: "app/dependabot" } })), "depbot");
  assert.equal(getBotAgent(makePR({ author: { login: "alice" } })), null);
});

test("isBotPR handles missing author gracefully", () => {
  assert.ok(!isBotPR(makePR({ author: undefined as unknown as { login: string } })));
});

// -- formatGhError --

test("formatGhError extracts stderr message", () => {
  const err = { stderr: "permission denied", message: "exec failed" } as ExecError;
  assert.equal(formatGhError(err), "permission denied");
});

test("formatGhError falls back to message when stderr is empty", () => {
  const err = { stderr: "", message: "exec failed" } as ExecError;
  assert.equal(formatGhError(err), "exec failed");
});

test("formatGhError adds context prefix", () => {
  const err = { stderr: "not found", message: "" } as ExecError;
  assert.equal(formatGhError(err, "listing PRs"), "listing PRs: not found");
});

test("formatGhError returns Unknown error for empty errors", () => {
  const err = { stderr: "", message: "" } as ExecError;
  assert.equal(formatGhError(err), "Unknown error");
});

// -- mergeCommitMentionsBranch --

test("mergeCommitMentionsBranch detects merge commit with branch", () => {
  assert.ok(mergeCommitMentionsBranch("Merge pull request #42 from cursor/fix-bug", "cursor/fix-bug"));
  assert.ok(mergeCommitMentionsBranch("Merge pull request #42 from owner/cursor/fix-bug", "cursor/fix-bug"));
});

test("mergeCommitMentionsBranch is case-insensitive", () => {
  assert.ok(mergeCommitMentionsBranch("Merge Pull Request #1 from CURSOR/FIX", "cursor/fix"));
});

test("mergeCommitMentionsBranch returns false for non-merge commits", () => {
  assert.ok(!mergeCommitMentionsBranch("Fix a bug in login", "cursor/fix"));
  assert.ok(!mergeCommitMentionsBranch("Update README", "cursor/fix"));
});

test("mergeCommitMentionsBranch returns false for unrelated merge commits", () => {
  assert.ok(!mergeCommitMentionsBranch("Merge pull request #10 from other/branch", "cursor/fix"));
});

// -- Error classes --

test("GhNotFoundError has descriptive message", () => {
  const err = new GhNotFoundError();
  assert.ok(err.message.includes("not installed"));
  assert.equal(err.name, "GhNotFoundError");
});

test("GhNotAuthenticatedError has descriptive message", () => {
  const err = new GhNotAuthenticatedError();
  assert.ok(err.message.includes("not authenticated"));
  assert.equal(err.name, "GhNotAuthenticatedError");
});

// -- AGENT_BRANCH_PATTERNS --

test("AGENT_BRANCH_PATTERNS match branch prefixes", () => {
  assert.ok(AGENT_BRANCH_PATTERNS.cursor.test("cursor/fix-bug"));
  assert.ok(AGENT_BRANCH_PATTERNS.claude.test("claude/add-tests"));
  assert.ok(AGENT_BRANCH_PATTERNS.copilot.test("copilot/refactor"));
});

test("AGENT_BRANCH_PATTERNS do not match mid-name occurrences", () => {
  assert.ok(!AGENT_BRANCH_PATTERNS.cursor.test("feature/cursor-fix"));
  assert.ok(!AGENT_BRANCH_PATTERNS.claude.test("feature/claude-test"));
});
