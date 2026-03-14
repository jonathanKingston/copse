import test from "node:test";
import assert from "node:assert/strict";
import { getIssueTemplateComment } from "../lib/services/status-actions.js";

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
