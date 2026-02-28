#!/usr/bin/env node

/**
 * Finds agent branches (cursor/*, claude/*) recently created/updated and creates PRs from them.
 *
 * Usage: create-prs <repo> <agent> [options]
 *
 * PR title comes from the latest commit subject; PR body combines an optional template
 * with the commit body (for detailed change descriptions and co-authorship).
 *
 * Branch patterns (from images):
 *   - cursor/fix-any-type-history-utils-55cd → base: pr-releases/cursor/fix-any-type-history-utils-55cd
 *   - claude/fix-any-overlay-messages-bINaq → base: pr-releases/claude/fix-any-overlay-messages-bINaq
 */

import { execSync, type ExecSyncOptions } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const DEFAULT_TEMPLATE_URL =
  "https://raw.githubusercontent.com/duckduckgo/content-scope-scripts/main/.github/pull_request_template.md";

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function validateRepo(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repo: "${repo}". Use owner/name format (e.g. acme/cool-project)`);
  }
}

const AGENT_PATTERNS: Record<string, RegExp> = {
  cursor: /^cursor\//i,
  claude: /^claude\//i,
};

function exec(cmd: string, options: ExecSyncOptions = {}): string {
  return execSync(cmd, { encoding: "utf-8", ...options }) as string;
}

function listBranches(repo: string): string[] {
  const out = exec(
    `gh api "repos/${repo}/branches" --paginate -q '.[].name'`
  );
  return out.trim() ? out.trim().split("\n") : [];
}

function listOpenPRHeadBranches(repo: string): string[] {
  const out = exec(
    `gh pr list --repo ${repo} --state open --limit 500 --json headRefName -q '.[].headRefName'`
  );
  return out.trim() ? out.trim().split("\n") : [];
}

const COMMIT_DELIM = "\x01";

function getCurrentUser(): string {
  const out = exec(`gh api user -q '.login'`);
  return out.trim();
}

interface CommitInfo {
  message: string;
  date: Date | null;
  authorLogin: string;
}

function getLatestCommit(repo: string, branchRef: string): CommitInfo {
  const ref = encodeURIComponent(branchRef);
  const out = exec(
    `gh api "repos/${repo}/commits/${ref}" -q '.commit.message + "${COMMIT_DELIM}" + .commit.author.date + "${COMMIT_DELIM}" + (.author.login // "")'`
  );
  const parts = out.trim().split(COMMIT_DELIM);
  const [message, dateStr, authorLogin] = parts;
  return {
    message: (message || "").trim(),
    date: dateStr ? new Date(dateStr.trim()) : null,
    authorLogin: (authorLogin || "").trim(),
  };
}

function parseCommitMessage(message: string): { title: string; body: string } {
  const lines = (message || "").split("\n");
  const title = (lines[0] || "").trim();
  const body = lines.slice(1).join("\n").trim();
  return { title, body };
}

async function fetchTemplate(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.text()).trim();
}

async function resolveTemplate(templatePath: string): Promise<string> {
  let body = "";
  if (templatePath) {
    try {
      body = readFileSync(resolve(templatePath), "utf-8").trim();
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      console.error(`Warning: template file not found: ${templatePath}`);
    }
  }
  if (!body) {
    body = (await fetchTemplate(DEFAULT_TEMPLATE_URL)) ?? "";
  }
  return body;
}

function buildPRBody(templateContent: string, commitBody: string): string | undefined {
  if (commitBody) {
    return templateContent
      ? `${templateContent}\n\n---\n\n${commitBody}`
      : commitBody;
  }
  return templateContent || undefined;
}

function escapeShell(s: string): string {
  return (s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function createPR(repo: string, headBranch: string, baseBranch: string, title: string, body: string | undefined, dryRun: boolean): true | null {
  if (dryRun) {
    console.log(
      `Would create PR: ${headBranch} → ${baseBranch}\n  Title: ${title}`
    );
    return null;
  }
  const cmd = [
    "gh pr create",
    `--repo ${repo}`,
    `--base "${escapeShell(baseBranch)}"`,
    `--head "${escapeShell(headBranch)}"`,
    `--title "${escapeShell(title || "Update")}"`,
    body ? "--body-file -" : "",
  ]
    .filter(Boolean)
    .join(" ");
  exec(cmd, body ? { input: body } : {});
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const filtered = args.filter((a) => a !== "--dry-run" && a !== "--all");

  const help = `Usage: create-prs <repo> <agent> [options]

  repo       GitHub repo in owner/name format (e.g. acme/cool-project)
  agent      "cursor" or "claude" to filter branches

Options:
  --base BRANCH     Base branch (default: main). Use "pr-releases" for pr-releases/<head-branch>
  --template PATH   Path to PR template (default: .github/PULL_REQUEST_TEMPLATE.md)
  --no-template    Skip template, use only commit body
  --hours N         Only branches with commits in last N hours (default: 6)
  --mine            Only your branches (default)
  --all             Include branches from all authors
  --dry-run         Show branches and PRs that would be created

Examples:
  create-prs acme/cool-project cursor   # only your branches (default)
  create-prs acme/cool-project claude --base main --template .github/PULL_REQUEST_TEMPLATE.md
  create-prs acme/cool-project cursor --hours 48 --dry-run
  create-prs acme/cool-project cursor --all   # include branches from all authors
`;

  if (filtered.length < 2) {
    console.error(help);
    process.exit(1);
  }

  const [repo, agent] = filtered.slice(0, 2);
  validateRepo(repo);
  const rest = filtered.slice(2);

  if (!["cursor", "claude"].includes(agent.toLowerCase())) {
    console.error(`Error: agent must be "cursor" or "claude", got "${agent}"`);
    process.exit(1);
  }

  let baseBranch = "main";
  let templatePath: string | null = ".github/PULL_REQUEST_TEMPLATE.md";
  let hours = 6;
  let mineOnly = true;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--base" && rest[i + 1]) {
      baseBranch = rest[++i];
    } else if (a === "--template" && rest[i + 1]) {
      templatePath = rest[++i];
    } else if (a === "--no-template") {
      templatePath = null;
    } else if (a === "--hours" && rest[i + 1]) {
      hours = parseInt(rest[++i], 10);
      if (Number.isNaN(hours) || hours < 1) {
        console.error("Error: --hours must be a positive number");
        process.exit(1);
      }
    } else if (a === "--all") {
      mineOnly = false;
    } else if (a === "--mine") {
      mineOnly = true;
    }
  }

  let currentUser: string | null = null;
  if (mineOnly) {
    currentUser = getCurrentUser();
    console.error(`Filtering to your branches (@${currentUser})`);
  }

  const pattern = AGENT_PATTERNS[agent.toLowerCase()];
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  console.error(`Fetching branches from ${repo}...`);
  const allBranches = listBranches(repo);
  const agentBranches = allBranches.filter((b) => pattern.test(b));

  if (agentBranches.length === 0) {
    console.error(`No agent branches (${agent}/*) found.`);
    process.exit(0);
  }

  console.error(`Fetching open PR head branches...`);
  const prHeads = new Set(listOpenPRHeadBranches(repo));

  const withCommits: { branch: string; message: string }[] = [];
  for (const branch of agentBranches) {
    if (prHeads.has(branch)) {
      console.error(`  Skipping ${branch} (PR already exists)`);
      continue;
    }
    try {
      const { message, date, authorLogin } = getLatestCommit(repo, branch);
      if (date && date < since) {
        console.error(`  Skipping ${branch} (last commit ${date.toISOString()} outside --hours ${hours})`);
        continue;
      }
      if (mineOnly) {
        if (authorLogin !== currentUser) {
          console.error(`  Skipping ${branch} (latest commit by @${authorLogin || "unknown"}, not you)`);
          continue;
        }
      }
      withCommits.push({ branch, message });
    } catch (e: unknown) {
      console.error(`  Skipping ${branch}: ${(e as Error).message}`);
    }
  }

  if (withCommits.length === 0) {
    console.error("No branches to create PRs for.");
    process.exit(0);
  }

  console.error(`Found ${withCommits.length} branch(es) to create PRs for:`);
  for (const { branch } of withCommits) {
    console.error(`  ${branch}`);
  }

  const baseIsPrefix = baseBranch === "pr-releases";

  const templateContent = templatePath
    ? await resolveTemplate(templatePath)
    : "";

  for (const { branch, message } of withCommits) {
    const { title, body } = parseCommitMessage(message);
    const prBody = buildPRBody(templateContent, body);
    const base = baseIsPrefix ? `pr-releases/${branch}` : baseBranch;

    if (dryRun) {
      console.log(`\n${branch} → ${base}`);
      console.log(`  Title: ${title}`);
      if (prBody) console.log(`  Body (excerpt): ${prBody.slice(0, 80)}...`);
    } else {
      try {
        createPR(repo, branch, base, title, prBody, false);
        console.log(`Created PR: ${branch} → ${base}`);
      } catch (e: unknown) {
        console.error(`Failed to create PR for ${branch}: ${(e as Error).message}`);
        process.exit(1);
      }
    }
  }

  console.error(dryRun ? "(dry run - no PRs created)" : "Done.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
