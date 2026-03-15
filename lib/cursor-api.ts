import { getApiProvider } from "./api-provider.js";

const CURSOR_API_BASE_URL = "https://api.cursor.com";
const DEFAULT_LIST_LIMIT = 100;

export interface CursorAgent {
  id: string;
  status?: string;
  createdAt?: string;
  target?: {
    url?: string;
    prUrl?: string;
  };
}

export interface CursorArtifact {
  absolutePath: string;
  sizeBytes?: number;
  updatedAt?: string;
}

interface CursorListAgentsResponse {
  agents?: CursorAgent[];
  nextCursor?: string;
}

interface CursorListArtifactsResponse {
  artifacts?: CursorArtifact[];
}

interface CursorArtifactDownloadResponse {
  url?: string;
  expiresAt?: string;
}

interface CursorFollowupResponse {
  id: string;
}

interface CursorLaunchResponse {
  id: string;
}

interface LaunchTargetOptions {
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
}

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function cursorRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(`${CURSOR_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const responseText = await response.text();
  if (!response.ok) {
    const details = responseText ? `: ${responseText}` : "";
    throw new Error(`Cursor API ${response.status} ${response.statusText}${details}`);
  }

  if (!responseText) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new Error(`Cursor API returned invalid JSON for ${path}`);
  }
}

/**
 * List all Cursor agents associated with a pull request URL.
 * @param apiKey - Cursor API key for authentication
 * @param prUrl - Full GitHub pull request URL
 * @returns Array of Cursor agent objects
 */
export async function listAgentsByPrUrl(apiKey: string, prUrl: string): Promise<CursorAgent[]> {
  const provider = getApiProvider();
  if (provider?.cursorListAgentsByPrUrl) {
    return provider.cursorListAgentsByPrUrl(apiKey, prUrl);
  }
  const agents: CursorAgent[] = [];
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams({
      prUrl,
      limit: String(DEFAULT_LIST_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);
    const result = await cursorRequest<CursorListAgentsResponse>(
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

/**
 * Find the most recently created Cursor agent for a pull request URL.
 * @param apiKey - Cursor API key for authentication
 * @param prUrl - Full GitHub pull request URL
 * @returns The latest agent, or null if none found
 */
export async function findLatestAgentByPrUrl(apiKey: string, prUrl: string): Promise<CursorAgent | null> {
  const provider = getApiProvider();
  if (provider?.cursorFindLatestAgentByPrUrl) {
    return provider.cursorFindLatestAgentByPrUrl(apiKey, prUrl);
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

/**
 * Send a follow-up prompt to an existing Cursor agent.
 * @param apiKey - Cursor API key for authentication
 * @param agentId - ID of the agent to follow up with
 * @param text - The follow-up prompt text
 * @returns The agent ID from the response
 */
export async function addFollowup(apiKey: string, agentId: string, text: string): Promise<string> {
  const provider = getApiProvider();
  if (provider?.cursorAddFollowup) {
    return provider.cursorAddFollowup(apiKey, agentId, text);
  }
  const payload = {
    prompt: {
      text,
    },
  };
  const response = await cursorRequest<CursorFollowupResponse>(
    apiKey,
    `/v0/agents/${encodeURIComponent(agentId)}/followup`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
  if (!response.id) {
    throw new Error("Cursor API follow-up response did not include agent id");
  }
  return response.id;
}

/**
 * Launch a new Cursor agent targeting an existing pull request.
 * @param apiKey - Cursor API key for authentication
 * @param prUrl - Full GitHub pull request URL to target
 * @param text - The prompt text for the agent
 * @returns The newly created agent ID
 */
export async function launchAgentForPrUrl(apiKey: string, prUrl: string, text: string): Promise<string> {
  const provider = getApiProvider();
  if (provider?.cursorLaunchAgentForPrUrl) {
    return provider.cursorLaunchAgentForPrUrl(apiKey, prUrl, text);
  }
  const payload = {
    prompt: {
      text,
    },
    source: {
      prUrl,
    },
  };
  const response = await cursorRequest<CursorLaunchResponse>(apiKey, "/v0/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.id) {
    throw new Error("Cursor API launch response did not include agent id");
  }
  return response.id;
}

/**
 * Launch a new Cursor agent targeting a repository.
 * @param apiKey - Cursor API key for authentication
 * @param repository - Repository identifier
 * @param text - The prompt text for the agent
 * @param target - Optional launch target options
 * @returns The newly created agent ID
 */
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
  const response = await cursorRequest<CursorLaunchResponse>(apiKey, "/v0/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.id) {
    throw new Error("Cursor API launch response did not include agent id");
  }
  return response.id;
}

/**
 * List artifacts produced by a Cursor agent.
 * @param apiKey - Cursor API key for authentication
 * @param agentId - ID of the agent
 * @returns Array of artifact descriptors
 */
export async function listAgentArtifacts(apiKey: string, agentId: string): Promise<CursorArtifact[]> {
  const provider = getApiProvider();
  if (provider?.cursorListAgentArtifacts) {
    return provider.cursorListAgentArtifacts(apiKey, agentId);
  }
  const response = await cursorRequest<CursorListArtifactsResponse>(
    apiKey,
    `/v0/agents/${encodeURIComponent(agentId)}/artifacts`,
    { method: "GET" }
  );
  return response.artifacts ?? [];
}

/**
 * Get a temporary download URL for a Cursor agent artifact.
 * @param apiKey - Cursor API key for authentication
 * @param agentId - ID of the agent that produced the artifact
 * @param absolutePath - Absolute file path of the artifact
 * @returns Object with the download URL and optional expiry timestamp
 */
export async function getArtifactDownloadUrl(
  apiKey: string,
  agentId: string,
  absolutePath: string
): Promise<{ url: string; expiresAt?: string }> {
  const provider = getApiProvider();
  if (provider?.cursorGetArtifactDownloadUrl) {
    return provider.cursorGetArtifactDownloadUrl(apiKey, agentId, absolutePath);
  }
  const params = new URLSearchParams({ path: absolutePath });
  const response = await cursorRequest<CursorArtifactDownloadResponse>(
    apiKey,
    `/v0/agents/${encodeURIComponent(agentId)}/artifacts/download?${params.toString()}`,
    { method: "GET" }
  );
  if (!response.url) {
    throw new Error("Cursor API artifact download response did not include url");
  }
  return { url: response.url, expiresAt: response.expiresAt };
}
