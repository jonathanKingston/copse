#!/usr/bin/env node

/**
 * Finds recent agent branches (cursor/*, claude/*) and reruns failed workflow runs.
 *
 * Usage: rerun-failed <repo> <agent> [options]
 */

import { execSync } from "child_process";

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function validateRepo(repo) {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repo: "${repo}". Use owner/name format (e.g. acme/cool-project)`);
  }
}

const AGENT_PATTERNS = {
  cursor: /^cursor\//i,
  claude: /^claude\//i,
};

function exec(cmd, options = {}) {
  return execSync(cmd, { encoding: "utf-8", ...options });
}

function listBranches(repo) {
  const out = exec(
    `gh api "repos/${repo}/branches" --paginate -q '.[].name'`
  );
  return out.trim() ? out.trim().split("\n") : [];
}

function getCurrentUser() {
  const out = exec(`gh api user -q '.login'`);
  return out.trim();
}

function getLatestCommitInfo(repo, branchRef) {
  const ref = encodeURIComponent(branchRef);
  const out = exec(
    `gh api "repos/${repo}/commits/${ref}" -q '.commit.author.date + "\x01" + (.author.login // "")'`
  );
  const [dateStr, authorLogin] = out.trim().split("\x01");
  return {
    date: dateStr ? new Date(dateStr) : null,
    authorLogin: (authorLogin || "").trim(),
  };
}

function listFailedRuns(repo, branch) {
  try {
    const out = exec(
      `gh run list --repo ${repo} --branch "${branch.replace(/"/g, '\\"')}" --status failure --limit 50 --json databaseId,name,conclusion`
    );
    const runs = JSON.parse(out || "[]");
    return Array.isArray(runs) ? runs : [];
  } catch (e) {
    return [];
  }
}

function rerunWorkflow(repo, runId, dryRun) {
  if (dryRun) return true;
  try {
    exec(`gh run rerun ${runId} --repo ${repo} --failed`);
    return true;
  } catch (e) {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const filtered = args.filter((a) => a !== "--dry-run" && a !== "--all");

  const help = `Usage: rerun-failed <repo> <agent> [options]

  repo       GitHub repo in owner/name format (e.g. acme/cool-project)
  agent      "cursor" or "claude" to filter branches

Options:
  --hours N   Only branches with commits in last N hours (default: 24)
  --mine      Only your branches (default)
  --all       Include branches from all authors
  --dry-run   Show branches and runs that would be rerun without triggering

Examples:
  rerun-failed acme/cool-project cursor
  rerun-failed acme/cool-project claude --hours 48 --dry-run
  rerun-failed acme/cool-project cursor --all
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

  let hours = 24;
  let mineOnly = !all;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--hours" && rest[i + 1]) {
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

  let currentUser = null;
  if (mineOnly) {
    currentUser = getCurrentUser();
  }

  const pattern = AGENT_PATTERNS[agent.toLowerCase()];
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  if (mineOnly) {
    console.error(`Fetching branches from ${repo} (only yours, @${currentUser})...`);
  } else {
    console.error(`Fetching branches from ${repo} (all authors)...`);
  }
  const allBranches = listBranches(repo);
  const agentBranches = allBranches.filter((b) => pattern.test(b));

  if (agentBranches.length === 0) {
    console.error(`No agent branches (${agent}/*) found.`);
    process.exit(0);
  }

  const recentBranches = [];
  for (const branch of agentBranches) {
    try {
      const { date, authorLogin } = getLatestCommitInfo(repo, branch);
      if (!date || date < since) continue;
      if (mineOnly) {
        if (authorLogin !== currentUser) {
          console.error(`  Skipping ${branch} (latest commit by @${authorLogin || "unknown"}, not you)`);
          continue;
        }
      }
      recentBranches.push(branch);
    } catch (e) {
      console.error(`  Skipping ${branch}: ${e.message}`);
    }
  }

  if (recentBranches.length === 0) {
    console.error(
      `No branches with commits in the last ${hours} hour(s). Use --hours to widen.`
    );
    process.exit(0);
  }

  console.error(
    `Found ${recentBranches.length} recent branch(es). Checking for failed runs...`
  );

  let totalRerun = 0;
  for (const branch of recentBranches) {
    const failed = listFailedRuns(repo, branch);
    if (failed.length === 0) continue;

    console.error(`  ${branch}: ${failed.length} failed run(s)`);
    for (const run of failed) {
      const label = run.name ? `${run.name} #${run.databaseId}` : `#${run.databaseId}`;
      if (dryRun) {
        console.log(`Would rerun: ${branch} - ${label}`);
      } else {
        const ok = rerunWorkflow(repo, run.databaseId, false);
        console.log(
          ok
            ? `Reran: ${branch} - ${label}`
            : `Failed to rerun: ${branch} - ${label}`
        );
      }
      totalRerun++;
    }
  }

  if (totalRerun === 0) {
    console.error("No failed workflow runs found on recent branches.");
  } else {
    console.error(
      dryRun
        ? `(dry run - would rerun ${totalRerun} run(s))`
        : `Done. Reran ${totalRerun} failed run(s).`
    );
  }
}

main();
