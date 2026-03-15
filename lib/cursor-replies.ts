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

/**
 * Build the full GitHub URL for a pull request.
 * @param repo - Repository in "owner/name" format
 * @param prNumber - The pull request number
 * @returns The full GitHub PR URL
 */
export function buildPrUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

/**
 * Send a reply to a PR via the Cursor API, either as a follow-up or by launching a new agent.
 * @param input - Parameters including repo, PR number, reply text, and API key
 * @param client - Optional Cursor API client (defaults to production client)
 * @returns Result indicating whether a follow-up or new launch was performed
 */
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
