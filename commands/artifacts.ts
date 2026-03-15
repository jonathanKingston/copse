/**
 * Lists Cursor Cloud Agent artifacts for a PR and optionally downloads one.
 *
 * Usage: copse artifacts <repo> <pr-number> [--download ABSOLUTE_PATH] [--out FILE]
 */
import { initializeRuntime } from "../lib/runtime-init.js";
import { validateRepo } from "../lib/gh.js";
import { loadConfig } from "../lib/config.js";
import {
  findLatestAgentByPrUrl as findLatestCursorAgentByPrUrl,
  getArtifactDownloadUrl as getCursorArtifactDownloadUrl,
  listAgentArtifacts as listCursorAgentArtifacts,
} from "../lib/cursor-api.js";
import {
  findLatestAgentByPrUrl as findLatestClaudeAgentByPrUrl,
  getArtifactDownloadUrl as getClaudeArtifactDownloadUrl,
  listAgentArtifacts as listClaudeAgentArtifacts,
} from "../lib/claude-api.js";
import { formatBytes } from "../lib/format.js";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { basename as pathBasename } from "node:path";

initializeRuntime();

function usage(): string {
  return `Usage: copse artifacts <repo> <pr-number> [--download ABSOLUTE_PATH] [--out FILE]

Lists artifacts from the latest Cursor Cloud Agent linked to the PR URL.

Arguments:
  repo                 GitHub repo in owner/name format (e.g. acme/cool-project)
  pr-number            Pull request number

Options:
  --download PATH      Download the artifact at PATH (absolutePath from the list)
  --out FILE           Output file path (default: ./<basename of artifact path>)

Notes:
  Requires "cursorApiKey" configured in .copserc.
`;
}

function parseArgs(argv: string[]): {
  repo: string;
  prNumber: number;
  downloadPath: string | null;
  outFile: string | null;
} {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const repo = argv[0] || "";
  const prNumberRaw = argv[1] || "";
  if (!repo || !prNumberRaw) {
    console.error(usage());
    process.exit(1);
  }

  const prNumber = parseInt(prNumberRaw, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`Invalid pull request number: "${prNumberRaw}"`);
    process.exit(1);
  }

  let downloadPath: string | null = null;
  let outFile: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--download") {
      const v = argv[i + 1];
      if (!v) {
        console.error("--download requires a value");
        process.exit(1);
      }
      downloadPath = v;
      i++;
      continue;
    }
    if (a === "--out") {
      const v = argv[i + 1];
      if (!v) {
        console.error("--out requires a value");
        process.exit(1);
      }
      outFile = v;
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
  }

  return { repo, prNumber, downloadPath, outFile };
}

async function downloadFile(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  // Node's Readable.fromWeb typing doesn't always align with lib.dom's ReadableStream generics.
  await pipeline(
    Readable.fromWeb(res.body as unknown as NodeReadableStream),
    createWriteStream(outPath, { flags: "wx" })
  );
}

async function main(): Promise<void> {
  const { repo, prNumber, downloadPath, outFile } = parseArgs(process.argv.slice(2));
  validateRepo(repo);

  const config = loadConfig();
  const cursorApiKey = config?.cursorApiKey?.trim() || "";
  const claudeApiKey = config?.claudeApiKey?.trim() || "";
  if (!cursorApiKey && !claudeApiKey) {
    console.error('No agent API configured. Set "cursorApiKey" or "claudeApiKey" in .copserc.');
    process.exit(1);
  }

  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;

  // Try Cursor first, then Claude
  let agentId: string | null = null;
  let agentLabel = "";
  let artifactList: Array<{ absolutePath: string; sizeBytes?: number; updatedAt?: string }> = [];
  let getDownloadUrl: ((agId: string, path: string) => Promise<{ url: string; expiresAt?: string }>) | null = null;

  if (cursorApiKey) {
    const agent = await findLatestCursorAgentByPrUrl(cursorApiKey, prUrl);
    if (agent) {
      agentId = agent.id;
      agentLabel = "Cursor";
      artifactList = await listCursorAgentArtifacts(cursorApiKey, agent.id);
      getDownloadUrl = (agId, path) => getCursorArtifactDownloadUrl(cursorApiKey, agId, path);
    }
  }

  if (!agentId && claudeApiKey) {
    const agent = await findLatestClaudeAgentByPrUrl(claudeApiKey, prUrl);
    if (agent) {
      agentId = agent.id;
      agentLabel = "Claude";
      artifactList = await listClaudeAgentArtifacts(claudeApiKey, agent.id);
      getDownloadUrl = (agId, path) => getClaudeArtifactDownloadUrl(claudeApiKey, agId, path);
    }
  }

  if (!agentId) {
    console.error(`No agent linked to ${prUrl}`);
    process.exit(1);
  }

  console.log(`${agentLabel} agent: ${agentId}`);
  console.log(`PR: ${prUrl}`);
  console.log("");

  if (artifactList.length === 0) {
    console.log("No artifacts found.");
    process.exit(0);
  }

  for (const a of artifactList) {
    const size = formatBytes(a.sizeBytes ?? null);
    const updated = a.updatedAt ? new Date(a.updatedAt).toISOString() : "";
    console.log(`${a.absolutePath}  ${size}${updated ? `  ${updated}` : ""}`);
  }

  if (!downloadPath) return;

  const out = outFile || `./${pathBasename(downloadPath) || "artifact"}`;
  const { url } = await getDownloadUrl!(agentId, downloadPath);
  await downloadFile(url, out);
  console.log("");
  console.log(`Downloaded to ${out}`);
}

main().catch((e: unknown) => {
  const msg = (e as { code?: string }).code === "EEXIST"
    ? "Output file already exists"
    : (e as Error).message;
  console.error(msg);
  process.exit(1);
});

