import type { IncomingMessage, ServerResponse } from "node:http";
import { validateRepo } from "../../lib/gh.js";
import { findLatestAgentByPrUrl, getArtifactDownloadUrl, listAgentArtifacts, listAgentsByPrUrl } from "../../lib/cursor-api.js";
import {
  sendJson,
  parsePathSegments,
  requireCursorApiKey,
} from "./helpers.js";

export async function handleCursorRoutes(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
  const method = req.method || "GET";
  const segments = parsePathSegments(url);

  // Cursor artifacts for a PR (latest Cursor agent by PR URL).
  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "artifacts") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }

    const cursorApiKey = requireCursorApiKey();
    const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    const requestedAgentId = url.searchParams.get("agentId") || null;

    let agentId: string | null = null;
    if (requestedAgentId) {
      const agents = await listAgentsByPrUrl(cursorApiKey, prUrl);
      const match = agents.find((a) => a.id === requestedAgentId) ?? null;
      if (!match) {
        throw new Error("Unknown agentId for this PR");
      }
      agentId = match.id;
    } else {
      const agent = await findLatestAgentByPrUrl(cursorApiKey, prUrl);
      agentId = agent?.id ?? null;
    }

    if (!agentId) {
      sendJson(res, 200, { repo, prNumber, prUrl, agentId: null, artifacts: [] });
      return true;
    }

    const artifacts = await listAgentArtifacts(cursorApiKey, agentId);
    sendJson(res, 200, { repo, prNumber, prUrl, agentId, artifacts });
    return true;
  }

  // Cursor agents previously run for a PR (by PR URL).
  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "agents") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }
    const cursorApiKey = requireCursorApiKey();
    const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    const agents = await listAgentsByPrUrl(cursorApiKey, prUrl);
    sendJson(res, 200, { repo, prNumber, prUrl, agents });
    return true;
  }

  // Redirect to presigned download URL (keeps Cursor API key server-side).
  if (
    method === "GET" &&
    segments.length === 6 &&
    segments[0] === "api" &&
    segments[1] === "cursor" &&
    segments[2] === "agents" &&
    segments[4] === "artifacts" &&
    segments[5] === "download"
  ) {
    const agentId = segments[3];
    const absolutePath = url.searchParams.get("path") || "";
    if (!absolutePath) {
      throw new Error('Missing required query param "path"');
    }
    const cursorApiKey = requireCursorApiKey();
    const { url: downloadUrl } = await getArtifactDownloadUrl(cursorApiKey, agentId, absolutePath);
    res.writeHead(302, {
      location: downloadUrl,
      "cache-control": "no-store",
    });
    res.end();
    return true;
  }

  return false;
}
