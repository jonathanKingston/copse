import { getApiProvider } from "./api-provider.js";

const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
const DEFAULT_LIST_LIMIT = 100;

export interface ClaudeAgent {
  id: string;
  status?: string;
  createdAt?: string;
  target?: {
    url?: string;
    prUrl?: string;
  };
}

export interface ClaudeArtifact {
  absolutePath: string;
  sizeBytes?: number;
  updatedAt?: string;
}

interface ClaudeListAgentsResponse {
  agents?: ClaudeAgent[];
  nextCursor?: string;
}

interface ClaudeListArtifactsResponse {
  artifacts?: ClaudeArtifact[];
}

interface ClaudeArtifactDownloadResponse {
  url?: string;
  expiresAt?: string;
}

interface ClaudeFollowupResponse {
  id: string;
}

interface ClaudeLaunchResponse {
  id: string;
}

interface LaunchTargetOptions {
  autoCreatePr?: boolean;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

async function claudeRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(`${CLAUDE_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...authHeaders(apiKey),
      ...(init.headers ?? {}),
    },
  });

  const responseText = await response.text();
  if (!response.ok) {
    const details = responseText ? `: ${responseText}` : "";
    throw new Error(`Claude API ${response.status} ${response.statusText}${details}`);
  }

  if (!responseText) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new Error(`Claude API returned invalid JSON for ${path}`);
  }
}

export async function listAgentsByPrUrl(apiKey: string, prUrl: string): Promise<ClaudeAgent[]> {
  const provider = getApiProvider();
  if (provider?.claudeListAgentsByPrUrl) {
    return provider.claudeListAgentsByPrUrl(apiKey, prUrl);
  }
  const agents: ClaudeAgent[] = [];
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams({
      prUrl,
      limit: String(DEFAULT_LIST_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);
    const result = await claudeRequest<ClaudeListAgentsResponse>(
      apiKey,
      `/v0/agents?${params.toString()}`,
      { method: "GET" }
    );
    agents.push(...(result.agents ?? []));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  return agents;
}

export async function findLatestAgentByPrUrl(apiKey: string, prUrl: string): Promise<ClaudeAgent | null> {
  const provider = getApiProvider();
  if (provider?.claudeFindLatestAgentByPrUrl) {
    return provider.claudeFindLatestAgentByPrUrl(apiKey, prUrl);
  }
  const agents = await listAgentsByPrUrl(apiKey, prUrl);
  if (agents.length === 0) return null;

  const sorted = [...agents].sort((a, b) => {
    const aTs = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTs = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTs - aTs;
  });
  return sorted[0] ?? null;
}

export async function addFollowup(apiKey: string, agentId: string, text: string): Promise<string> {
  const provider = getApiProvider();
  if (provider?.claudeAddFollowup) {
    return provider.claudeAddFollowup(apiKey, agentId, text);
  }
  const payload = {
    prompt: {
      text,
    },
  };
  const response = await claudeRequest<ClaudeFollowupResponse>(
    apiKey,
    `/v0/agents/${encodeURIComponent(agentId)}/followup`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
  if (!response.id) {
    throw new Error("Claude API follow-up response did not include agent id");
  }
  return response.id;
}

export async function launchAgentForPrUrl(apiKey: string, prUrl: string, text: string): Promise<string> {
  const provider = getApiProvider();
  if (provider?.claudeLaunchAgentForPrUrl) {
    return provider.claudeLaunchAgentForPrUrl(apiKey, prUrl, text);
  }
  const payload = {
    prompt: {
      text,
    },
    source: {
      prUrl,
    },
  };
  const response = await claudeRequest<ClaudeLaunchResponse>(apiKey, "/v0/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.id) {
    throw new Error("Claude API launch response did not include agent id");
  }
  return response.id;
}

export async function launchAgentForRepository(
  apiKey: string,
  repository: string,
  text: string,
  target: LaunchTargetOptions = {}
): Promise<string> {
  const payload = {
    prompt: {
      text,
    },
    source: {
      repository,
    },
    ...(Object.keys(target).length > 0 ? { target } : {}),
  };
  const response = await claudeRequest<ClaudeLaunchResponse>(apiKey, "/v0/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.id) {
    throw new Error("Claude API launch response did not include agent id");
  }
  return response.id;
}

export async function listAgentArtifacts(apiKey: string, agentId: string): Promise<ClaudeArtifact[]> {
  const provider = getApiProvider();
  if (provider?.claudeListAgentArtifacts) {
    return provider.claudeListAgentArtifacts(apiKey, agentId);
  }
  const response = await claudeRequest<ClaudeListArtifactsResponse>(
    apiKey,
    `/v0/agents/${encodeURIComponent(agentId)}/artifacts`,
    { method: "GET" }
  );
  return response.artifacts ?? [];
}

export async function getArtifactDownloadUrl(
  apiKey: string,
  agentId: string,
  absolutePath: string
): Promise<{ url: string; expiresAt?: string }> {
  const provider = getApiProvider();
  if (provider?.claudeGetArtifactDownloadUrl) {
    return provider.claudeGetArtifactDownloadUrl(apiKey, agentId, absolutePath);
  }
  const params = new URLSearchParams({ path: absolutePath });
  const response = await claudeRequest<ClaudeArtifactDownloadResponse>(
    apiKey,
    `/v0/agents/${encodeURIComponent(agentId)}/artifacts/download?${params.toString()}`,
    { method: "GET" }
  );
  if (!response.url) {
    throw new Error("Claude API artifact download response did not include url");
  }
  return { url: response.url, expiresAt: response.expiresAt };
}
