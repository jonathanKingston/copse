import {
  addFollowup,
  findLatestAgentByPrUrl,
  launchAgentForPrUrl,
} from "./claude-api.js";

export interface SendReplyViaClaudeApiInput {
  repo: string;
  prNumber: number;
  replyText: string;
  claudeApiKey: string;
}

export interface SendReplyViaClaudeApiResult {
  mode: "followup" | "launched";
  agentId: string;
  prUrl: string;
}

export interface ClaudeReplyClient {
  findLatestAgentByPrUrl(apiKey: string, prUrl: string): Promise<{ id: string } | null>;
  addFollowup(apiKey: string, agentId: string, text: string): Promise<string>;
  launchAgentForPrUrl(apiKey: string, prUrl: string, text: string): Promise<string>;
}

const defaultClient: ClaudeReplyClient = {
  findLatestAgentByPrUrl,
  addFollowup,
  launchAgentForPrUrl,
};

export function buildPrUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

export async function sendReplyViaClaudeApi(
  input: SendReplyViaClaudeApiInput,
  client: ClaudeReplyClient = defaultClient
): Promise<SendReplyViaClaudeApiResult> {
  const prUrl = buildPrUrl(input.repo, input.prNumber);
  const existingAgent = await client.findLatestAgentByPrUrl(input.claudeApiKey, prUrl);

  if (existingAgent) {
    const agentId = await client.addFollowup(input.claudeApiKey, existingAgent.id, input.replyText);
    return { mode: "followup", agentId, prUrl };
  }

  const launchedAgentId = await client.launchAgentForPrUrl(input.claudeApiKey, prUrl, input.replyText);
  return { mode: "launched", agentId: launchedAgentId, prUrl };
}
