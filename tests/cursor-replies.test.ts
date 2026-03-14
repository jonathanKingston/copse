import test from "node:test";
import assert from "node:assert/strict";

import { buildPrUrl, sendReplyViaCursorApi, type CursorReplyClient } from "../lib/cursor-replies.js";

test("buildPrUrl creates canonical GitHub PR URL", () => {
  assert.equal(buildPrUrl("acme/repo", 42), "https://github.com/acme/repo/pull/42");
});

test("sendReplyViaCursorApi sends follow-up when agent already exists", async () => {
  const calls: string[] = [];
  const client: CursorReplyClient = {
    async findLatestAgentByPrUrl(_apiKey, prUrl) {
      calls.push(`find:${prUrl}`);
      return { id: "bc_existing" };
    },
    async addFollowup(_apiKey, agentId, text) {
      calls.push(`followup:${agentId}:${text}`);
      return agentId;
    },
    async launchAgentForPrUrl() {
      calls.push("launch");
      return "bc_new";
    },
  };

  const result = await sendReplyViaCursorApi(
    {
      repo: "acme/repo",
      prNumber: 10,
      replyText: "please fix this",
      cursorApiKey: "secret",
    },
    client
  );

  assert.equal(result.mode, "followup");
  assert.equal(result.agentId, "bc_existing");
  assert.deepEqual(calls, [
    "find:https://github.com/acme/repo/pull/10",
    "followup:bc_existing:please fix this",
  ]);
});

test("sendReplyViaCursorApi launches a new agent when no existing one is linked", async () => {
  const calls: string[] = [];
  const client: CursorReplyClient = {
    async findLatestAgentByPrUrl(_apiKey, prUrl) {
      calls.push(`find:${prUrl}`);
      return null;
    },
    async addFollowup() {
      calls.push("followup");
      return "bc_should_not_happen";
    },
    async launchAgentForPrUrl(_apiKey, prUrl, text) {
      calls.push(`launch:${prUrl}:${text}`);
      return "bc_new";
    },
  };

  const result = await sendReplyViaCursorApi(
    {
      repo: "acme/repo",
      prNumber: 11,
      replyText: "new instruction",
      cursorApiKey: "secret",
    },
    client
  );

  assert.equal(result.mode, "launched");
  assert.equal(result.agentId, "bc_new");
  assert.deepEqual(calls, [
    "find:https://github.com/acme/repo/pull/11",
    "launch:https://github.com/acme/repo/pull/11:new instruction",
  ]);
});
