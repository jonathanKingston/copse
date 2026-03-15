/**
 * Lists Cursor Cloud Agent artifacts for a PR and optionally downloads one.
 *
 * Usage: copse artifacts <repo> <pr-number> [--download ABSOLUTE_PATH] [--out FILE]
 */
import { initializeRuntime } from "../lib/runtime-init.js";
import { validateRepo } from "../lib/gh.js";
import { loadConfig } from "../lib/config.js";
import { findLatestAgentByPrUrl, getArtifactDownloadUrl, listAgentArtifacts } from "../lib/cursor-api.js";
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

  const cursorApiKey = loadConfig()?.cursorApiKey?.trim() || "";
  if (!cursorApiKey) {
    console.error('Cursor API not configured. Set "cursorApiKey" in .copserc.');
    process.exit(1);
  }

  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  const agent = await findLatestAgentByPrUrl(cursorApiKey, prUrl);
  if (!agent) {
    console.error(`No Cursor agent linked to ${prUrl}`);
    process.exit(1);
  }

  const artifacts = await listAgentArtifacts(cursorApiKey, agent.id);
  console.log(`Cursor agent: ${agent.id}`);
  console.log(`PR: ${prUrl}`);
  console.log("");

  if (artifacts.length === 0) {
    console.log("No artifacts found.");
    process.exit(0);
  }

  for (const a of artifacts) {
    const size = formatBytes(a.sizeBytes ?? null);
    const updated = a.updatedAt ? new Date(a.updatedAt).toISOString() : "";
    console.log(`${a.absolutePath}  ${size}${updated ? `  ${updated}` : ""}`);
  }

  if (!downloadPath) return;

  const out = outFile || `./${pathBasename(downloadPath) || "artifact"}`;
  const { url } = await getArtifactDownloadUrl(cursorApiKey, agent.id, downloadPath);
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

