/**
 * Cursor Cloud Agents API integration
 * Fetches active cloud agents from api.cursor.com
 */

import type { CursorAgent, CursorAgentsResponse } from "./types.js";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

function getCursorApiKey(): string | null {
  return process.env.CURSOR_API_KEY ?? null;
}

export function isCursorApiConfigured(): boolean {
  return getCursorApiKey() !== null;
}

async function fetchFromCursorApi(endpoint: string): Promise<string> {
  const apiKey = getCursorApiKey();
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY environment variable not set");
  }

  const url = `${CURSOR_API_BASE}${endpoint}`;
  const auth = Buffer.from(`${apiKey}:`).toString("base64");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cursor API error (${response.status}): ${text}`);
  }

  return await response.text();
}

export async function listCursorAgents(limit = 100, prUrl?: string): Promise<CursorAgent[]> {
  let endpoint = `/agents?limit=${limit}`;
  if (prUrl) {
    endpoint += `&prUrl=${encodeURIComponent(prUrl)}`;
  }

  const responseText = await fetchFromCursorApi(endpoint);
  const data = JSON.parse(responseText) as CursorAgentsResponse;
  return data.agents ?? [];
}

export async function listCursorAgentsForRepo(repo: string, limit = 100): Promise<CursorAgent[]> {
  const allAgents = await listCursorAgents(limit);
  return allAgents.filter((agent) => {
    if (agent.sourceRepo) {
      return agent.sourceRepo === repo || agent.sourceRepo.endsWith(`/${repo}`);
    }
    if (agent.prUrl) {
      return agent.prUrl.includes(`github.com/${repo}/`);
    }
    return false;
  });
}
