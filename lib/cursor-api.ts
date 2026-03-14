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

export async function listAgentsByPrUrl(apiKey: string, prUrl: string): Promise<CursorAgent[]> {
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

export async function findLatestAgentByPrUrl(apiKey: string, prUrl: string): Promise<CursorAgent | null> {
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

export async function launchAgentForPrUrl(apiKey: string, prUrl: string, text: string): Promise<string> {
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

export async function listAgentArtifacts(apiKey: string, agentId: string): Promise<CursorArtifact[]> {
  const response = await cursorRequest<CursorListArtifactsResponse>(
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
