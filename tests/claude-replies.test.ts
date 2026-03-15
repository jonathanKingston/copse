import test from "node:test";
import assert from "node:assert/strict";

import { buildPrUrl, sendReplyViaClaudeApi, type ClaudeReplyClient } from "../lib/claude-replies.js";

test("buildPrUrl creates canonical GitHub PR URL (claude)", () => {
  assert.equal(buildPrUrl("acme/repo", 42), "https://github.com/acme/repo/pull/42");
});

test("sendReplyViaClaudeApi sends follow-up when agent already exists", async () => {
  const calls: string[] = [];
  const client: ClaudeReplyClient = {
    async findLatestAgentByPrUrl(_apiKey, prUrl) {
      calls.push(`find:${prUrl}`);
      return { id: "claude_existing" };
    },
    async addFollowup(_apiKey, agentId, text) {
      calls.push(`followup:${agentId}:${text}`);
      return agentId;
    },
    async launchAgentForPrUrl() {
      calls.push("launch");
      return "claude_new";
    },
  };

  const result = await sendReplyViaClaudeApi(
    {
      repo: "acme/repo",
      prNumber: 10,
      replyText: "please fix this",
      claudeApiKey: "sk-ant-test",
    },
    client
  );

  assert.equal(result.mode, "followup");
  assert.equal(result.agentId, "claude_existing");
  assert.deepEqual(calls, [
    "find:https://github.com/acme/repo/pull/10",
    "followup:claude_existing:please fix this",
  ]);
});

test("sendReplyViaClaudeApi launches a new agent when no existing one is linked", async () => {
  const calls: string[] = [];
  const client: ClaudeReplyClient = {
    async findLatestAgentByPrUrl(_apiKey, prUrl) {
      calls.push(`find:${prUrl}`);
      return null;
    },
    async addFollowup() {
      calls.push("followup");
      return "claude_should_not_happen";
    },
    async launchAgentForPrUrl(_apiKey, prUrl, text) {
      calls.push(`launch:${prUrl}:${text}`);
      return "claude_new";
    },
  };

  const result = await sendReplyViaClaudeApi(
    {
      repo: "acme/repo",
      prNumber: 11,
      replyText: "new instruction",
      claudeApiKey: "sk-ant-test",
    },
    client
  );

  assert.equal(result.mode, "launched");
  assert.equal(result.agentId, "claude_new");
  assert.deepEqual(calls, [
    "find:https://github.com/acme/repo/pull/11",
    "launch:https://github.com/acme/repo/pull/11:new instruction",
  ]);
});
