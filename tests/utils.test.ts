import test from "node:test";
import assert from "node:assert/strict";

import { isBotComment } from "../lib/utils.js";
import type { PRReviewComment } from "../lib/types.js";

function makeComment(overrides: Partial<PRReviewComment> = {}): PRReviewComment {
  return {
    id: 1,
    node_id: "MDI_1",
    body: "test comment",
    path: "file.ts",
    line: 1,
    original_line: 1,
    diff_hunk: "@@ -1,3 +1,3 @@",
    user: { login: "reviewer" },
    created_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/owner/repo/pull/1#discussion_r1",
    pull_request_url: "https://api.github.com/repos/owner/repo/pulls/1",
    ...overrides,
  };
}

// -- isBotComment --

test("isBotComment detects Bot type users", () => {
  assert.ok(isBotComment(makeComment({ user: { login: "some-bot", type: "Bot" } })));
});

test("isBotComment detects -bot suffix", () => {
  assert.ok(isBotComment(makeComment({ user: { login: "review-bot" } })));
});

test("isBotComment detects [bot] suffix", () => {
  assert.ok(isBotComment(makeComment({ user: { login: "github-actions[bot]" } })));
});

test("isBotComment returns false for human users", () => {
  assert.ok(!isBotComment(makeComment({ user: { login: "alice" } })));
  assert.ok(!isBotComment(makeComment({ user: { login: "bob-smith" } })));
});

test("isBotComment handles missing user gracefully", () => {
  assert.ok(!isBotComment(makeComment({ user: undefined as unknown as { login: string } })));
});
