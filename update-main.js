#!/usr/bin/env node

/**
 * Merges main into open PR branches matching repo and agent filter.
 * Keeps PRs up to date with the latest main.
 *
 * Usage: update-main <repo> <agent> [options]
 */

import { execSync } from "child_process";

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function validateRepo(repo) {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repo: "${repo}". Use owner/name format (e.g. acme/cool-project)`);
  }
}

const AGENT_PATTERNS = {
  cursor: {
    branch: /cursor/i,
    labels: ["cursor", "cursor-pr"],
  },
  claude: {
    branch: /claude/i,
    labels: ["claude", "claude-pr"],
  },
};

function exec(cmd, options = {}) {
  return execSync(cmd, { encoding: "utf-8", ...options });
}

function getCurrentUser() {
  const out = exec(`gh api user -q '.login'`);
  return out.trim();
}

function listOpenPRs(repo) {
  const out = exec(
    `gh pr list --repo ${repo} --state open --limit 200 --json number,headRefName,labels,title,author`
  );
  return JSON.parse(out);
}

function matchesAgent(pr, agent) {
  if (agent) {
    const pattern = AGENT_PATTERNS[agent];
    if (!pattern) return false;
    const branchMatch = pattern.branch.test(pr.headRefName);
    const labelNames = (pr.labels || []).map((l) => l.name?.toLowerCase());
    const labelMatch = pattern.labels.some((l) => labelNames.includes(l));
    return branchMatch || labelMatch;
  }
  return Object.keys(AGENT_PATTERNS).some((a) => matchesAgent(pr, a));
}

function mergeMainIntoBranch(repo, headRef, baseRef, dryRun) {
  if (dryRun) return { ok: true, skipped: true };
  try {
    exec(
      `gh api repos/${repo}/merges -f base=${headRef} -f head=${baseRef}`
    );
    return { ok: true };
  } catch (e) {
    const msg = (e.stderr || e.message || "").toLowerCase();
    if (msg.includes("nothing to merge") || msg.includes("already up to date")) {
      return { ok: true, alreadyUpToDate: true };
    }
    return { ok: false, error: e.message };
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const filtered = args.filter((a) => a !== "--dry-run" && a !== "--all");

  const help = `Usage: update-main <repo> [agent] [options]

  repo       GitHub repo in owner/name format (e.g. acme/cool-project)
  agent      Optional: "cursor" or "claude" to filter PRs. Omit to match both.

Options:
  --base BRANCH   Branch to merge into PRs (default: main)
  --mine          Only your PRs (default)
  --all           Include PRs from all authors
  --dry-run       Show PRs that would be updated without merging

Examples:
  update-main acme/cool-project
  update-main acme/cool-project cursor
  update-main acme/cool-project claude --base main --dry-run
  update-main acme/cool-project cursor --all
`;

  if (filtered.length < 1) {
    console.error(help);
    process.exit(1);
  }

  const repo = filtered[0];
  validateRepo(repo);
  let agent = null;
  let rest = filtered.slice(1);

  if (rest.length >= 1 && !rest[0].startsWith("--") && ["cursor", "claude"].includes(rest[0].toLowerCase())) {
    agent = rest[0].toLowerCase();
    rest = rest.slice(1);
  }

  let baseBranch = "main";
  let mineOnly = !all;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--base" && rest[i + 1]) {
      baseBranch = rest[++i];
    } else if (a === "--all") {
      mineOnly = false;
    } else if (a === "--mine") {
      mineOnly = true;
    }
  }

  const agentLower = agent;

  let currentUser = null;
  if (mineOnly) {
    currentUser = getCurrentUser();
    console.error(
      `Fetching open PRs from ${repo}${agentLower ? ` (agent: ${agentLower})` : " (cursor + claude)"} (only yours, @${currentUser})...`
    );
  } else {
    console.error(
      `Fetching open PRs from ${repo}${agentLower ? ` (agent: ${agentLower})` : " (cursor + claude)"} (all authors)...`
    );
  }
  const prs = listOpenPRs(repo);
  const matching = prs.filter((pr) => {
    if (!matchesAgent(pr, agentLower)) return false;
    if (mineOnly) {
      const authorLogin = pr.author?.login ?? "";
      return authorLogin === currentUser;
    }
    return true;
  });

  if (matching.length === 0) {
    console.error("No matching PRs found.");
    process.exit(0);
  }

  console.error(`Found ${matching.length} matching PR(s):`);
  for (const pr of matching) {
    console.error(`  #${pr.number} ${pr.title}`);
  }

  if (dryRun) {
    console.error("(dry run - no merges performed)");
    for (const pr of matching) {
      console.log(`#${pr.number} would merge ${baseBranch} into ${pr.headRefName}`);
    }
    process.exit(0);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const pr of matching) {
    const result = mergeMainIntoBranch(repo, pr.headRefName, baseBranch, false);
    if (result.skipped) {
      continue;
    }
    if (result.ok) {
      if (result.alreadyUpToDate) {
        console.log(`#${pr.number} already up to date with ${baseBranch}`);
        skipped++;
      } else {
        console.log(`#${pr.number} merged ${baseBranch} into ${pr.headRefName}`);
        updated++;
      }
    } else {
      console.error(`#${pr.number} failed: ${result.error}`);
      failed++;
    }
  }

  console.error(
    `Done. Updated ${updated}, skipped ${skipped} (already up to date), failed ${failed}.`
  );
  if (failed > 0) process.exit(1);
}

main();
