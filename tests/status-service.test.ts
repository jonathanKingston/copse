import test from "node:test";
import assert from "node:assert/strict";
import { applyCIStatus, filterPRsByStatusScope, filterStandaloneBranches, hasPRConflicts } from "../lib/services/status-service.js";
import type { PRWithStatus, StatusBasePR } from "../lib/services/status-types.js";

function makeRow(): PRWithStatus {
  return {
    rowType: "pr",
    repo: "acme/repo",
    number: 1,
    headRefName: "cursor/feature",
    baseRefName: "main",
    labels: [],
    title: "Title",
    author: { login: "alice" },
    isDraft: false,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    updatedAt: "",
    agent: "cursor",
    autoMerge: false,
    ciStatus: "none",
    conflicts: false,
    ageDays: 1,
    stale: false,
    readyToMerge: false,
    commentCount: 0,
  };
}

function makeBasePR(overrides: Partial<StatusBasePR>): StatusBasePR {
  return {
    number: 1,
    headRefName: "feature/default",
    baseRefName: "main",
    labels: [],
    title: "Title",
    author: { login: "someone" },
    ...overrides,
  };
}

test("applyCIStatus marks PR as fail when any workflow fails", () => {
  const row = makeRow();
  applyCIStatus(row, [
    { databaseId: 1, name: "ci", conclusion: "failure", status: "completed", displayTitle: "ci" },
  ]);
  assert.equal(row.ciStatus, "fail");
  assert.equal(row.readyToMerge, false);
});

test("applyCIStatus marks PR as pass and ready when approved and clean", () => {
  const row = makeRow();
  applyCIStatus(row, [
    { databaseId: 2, name: "ci", conclusion: "success", status: "completed", displayTitle: "ci" },
  ]);
  assert.equal(row.ciStatus, "pass");
  assert.equal(row.readyToMerge, true);
});

test("applyCIStatus keeps PR not ready when conflicts exist", () => {
  const row = makeRow();
  row.conflicts = true;
  applyCIStatus(row, [
    { databaseId: 3, name: "ci", conclusion: "success", status: "completed", displayTitle: "ci" },
  ]);
  assert.equal(row.ciStatus, "pass");
  assert.equal(row.readyToMerge, false);
});

test("hasPRConflicts prefers mergeable when GitHub reports a conflict", () => {
  assert.equal(hasPRConflicts({ mergeable: "CONFLICTING", mergeStateStatus: "CLEAN" }), true);
});

test("hasPRConflicts prefers mergeable when GitHub reports a clean merge", () => {
  assert.equal(hasPRConflicts({ mergeable: "MERGEABLE", mergeStateStatus: "HAS_CONFLICTS" }), false);
});

test("hasPRConflicts falls back to mergeStateStatus when mergeability is unknown", () => {
  assert.equal(hasPRConflicts({ mergeable: "UNKNOWN", mergeStateStatus: "HAS_CONFLICTS" }), true);
});

test("filterPRsByStatusScope includes my PRs and recursive stacked children", () => {
  const prs: StatusBasePR[] = [
    makeBasePR({ number: 10, headRefName: "stack/a", author: { login: "alice" } }),
    makeBasePR({ number: 11, headRefName: "stack/b", baseRefName: "stack/a", author: { login: "bob" } }),
    makeBasePR({ number: 12, headRefName: "stack/c", baseRefName: "stack/b", author: { login: "carol" } }),
    makeBasePR({ number: 13, headRefName: "stack/root", author: { login: "dave" } }),
  ];

  const filtered = filterPRsByStatusScope(prs, "my-stacks", "alice");

  assert.deepEqual(
    filtered.map((pr) => pr.number),
    [10, 11, 12]
  );
});

test("filterPRsByStatusScope excludes ancestor PRs above mine", () => {
  const prs: StatusBasePR[] = [
    makeBasePR({ number: 20, headRefName: "stack/a", author: { login: "dave" } }),
    makeBasePR({ number: 21, headRefName: "stack/b", baseRefName: "stack/a", author: { login: "alice" } }),
    makeBasePR({ number: 22, headRefName: "stack/c", baseRefName: "stack/b", author: { login: "carol" } }),
  ];

  const filtered = filterPRsByStatusScope(prs, "my-stacks", "alice");

  assert.deepEqual(
    filtered.map((pr) => pr.number),
    [21, 22]
  );
});

test("filterStandaloneBranches keeps only standalone agent branches", () => {
  const filtered = filterStandaloneBranches(
    [
      "main",
      "cursor/ready",
      "cursor/has-pr",
      "cursor/base-for-stack",
      "feature/manual",
      "claude/standalone",
    ],
    [
      makeBasePR({ number: 30, headRefName: "cursor/has-pr", baseRefName: "main" }),
      makeBasePR({ number: 31, headRefName: "cursor/child", baseRefName: "cursor/base-for-stack" }),
    ]
  );

  assert.deepEqual(filtered, ["cursor/ready", "cursor/base-for-stack", "claude/standalone"]);
});
