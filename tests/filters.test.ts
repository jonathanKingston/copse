import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFetchMessage,
  filterPRs,
  filterPRsByAgent,
  filterPRsByAuthor,
} from "../lib/filters.js";
import type { PR } from "../lib/types.js";

function makePR(overrides: Partial<PR>): PR {
  return {
    number: 1,
    headRefName: "feature/default",
    labels: [],
    title: "Default title",
    body: "",
    author: { login: "someone" },
    ...overrides,
  };
}

test("filterPRsByAuthor keeps current user PRs and bot PRs", () => {
  const prs: PR[] = [
    makePR({ number: 1, author: { login: "alice" } }),
    makePR({ number: 2, author: { login: "bob" } }),
    makePR({ number: 3, author: { login: "app/dependabot" } }),
  ];

  const filtered = filterPRsByAuthor(prs, "alice");

  assert.deepEqual(
    filtered.map((pr) => pr.number),
    [1, 3]
  );
});

test("filterPRsByAgent matches cursor via branch and label", () => {
  const prs: PR[] = [
    makePR({ number: 10, headRefName: "cursor/fix-copy", labels: [] }),
    makePR({ number: 11, headRefName: "feature/abc", labels: [{ name: "cursor-pr" }] }),
    makePR({ number: 12, headRefName: "cursor/new-ui", labels: [{ name: "enhancement" }] }),
  ];

  const filtered = filterPRsByAgent(prs, "cursor", "owner/repo");

  assert.deepEqual(
    filtered.map((pr) => pr.number),
    [10, 11, 12]
  );
});

test("filterPRsByAgent with no specific agent matches known agents", () => {
  const prs: PR[] = [
    makePR({ number: 20, headRefName: "cursor/new-flow" }),
    makePR({ number: 21, headRefName: "claude/fix-tests" }),
    makePR({ number: 22, labels: [{ name: "copilot-pr" }] }),
    makePR({ number: 23, headRefName: "copilot/feature/normal", labels: [] }),
  ];

  const filtered = filterPRsByAgent(prs, null, "owner/repo");

  assert.deepEqual(
    filtered.map((pr) => pr.number),
    [20, 21, 22, 23]
  );
});

test("filterPRs applies query matching and keeps bot PRs regardless of agent", () => {
  const prs: PR[] = [
    makePR({
      number: 30,
      headRefName: "cursor/fix-login",
      title: "Fix Login Flow",
      author: { login: "alice" },
    }),
    makePR({
      number: 31,
      headRefName: "feature/unrelated",
      title: "Bump deps",
      body: "touches login package",
      author: { login: "app/dependabot" },
    }),
    makePR({
      number: 32,
      headRefName: "feature/docs",
      title: "Docs update",
      body: "no auth changes",
      author: { login: "bob" },
    }),
  ];

  const filtered = filterPRs(prs, {
    repo: "owner/repo",
    agent: "cursor",
    mineOnly: false,
    query: "LOGIN",
  });

  assert.deepEqual(
    filtered.map((pr) => pr.number),
    [30, 31]
  );
});

test("buildFetchMessage includes agent and author scope details", () => {
  const explicit = buildFetchMessage("owner/repo", "cursor", true, "alice");
  const defaultAgents = buildFetchMessage("owner/repo", null, false, null);

  assert.equal(
    explicit,
    "Fetching open PRs from owner/repo (agent: cursor) (only yours, @alice)..."
  );
  assert.equal(
    defaultAgents,
    "Fetching open PRs from owner/repo (cursor + claude) (all authors)..."
  );
});
