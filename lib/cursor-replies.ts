import {
  addFollowup,
  findLatestAgentByPrUrl,
  launchAgentForPrUrl,
} from "./cursor-api.js";

export interface SendReplyViaCursorApiInput {
  repo: string;
  prNumber: number;
  replyText: string;
  cursorApiKey: string;
}

export interface SendReplyViaCursorApiResult {
  mode: "followup" | "launched";
  agentId: string;
  prUrl: string;
}

export interface CursorReplyClient {
  findLatestAgentByPrUrl(apiKey: string, prUrl: string): Promise<{ id: string } | null>;
  addFollowup(apiKey: string, agentId: string, text: string): Promise<string>;
  launchAgentForPrUrl(apiKey: string, prUrl: string, text: string): Promise<string>;
}

const defaultClient: CursorReplyClient = {
  findLatestAgentByPrUrl,
  addFollowup,
  launchAgentForPrUrl,
};

export function buildPrUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

export async function sendReplyViaCursorApi(
  input: SendReplyViaCursorApiInput,
  client: CursorReplyClient = defaultClient
): Promise<SendReplyViaCursorApiResult> {
  const prUrl = buildPrUrl(input.repo, input.prNumber);
  const existingAgent = await client.findLatestAgentByPrUrl(input.cursorApiKey, prUrl);

  if (existingAgent) {
    const agentId = await client.addFollowup(input.cursorApiKey, existingAgent.id, input.replyText);
    return { mode: "followup", agentId, prUrl };
  }

  const launchedAgentId = await client.launchAgentForPrUrl(input.cursorApiKey, prUrl, input.replyText);
  return { mode: "launched", agentId: launchedAgentId, prUrl };
}
