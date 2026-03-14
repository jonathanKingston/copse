import test from "node:test";
import assert from "node:assert/strict";
import { applyCIStatus } from "../lib/services/status-service.js";
import type { PRWithStatus } from "../lib/services/status-types.js";

function makeRow(): PRWithStatus {
  return {
    repo: "acme/repo",
    number: 1,
    headRefName: "cursor/feature",
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
