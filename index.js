#!/usr/bin/env node

/**
 * Triggers "merge when ready" on PRs matching repo, agent filter, and optional query.
 * Uses gh pr merge --auto to enable auto-merge or add PRs to the merge queue.
 *
 * Usage: approval [repo] [agent] [query]
 *
 * Arguments:
 *   repo   - GitHub repo in owner/name format (e.g. acme/cool-project).
 *            Omit when run inside a git repo to use origin remote.
 *   agent  - Optional: "cursor" or "claude" to filter by agent. Omit to match both.
 *   query  - Optional text to match in PR title or body
 *
 * PRs are matched if they:
 *   - Are open in the given repo
 *   - Match the agent (branch contains agent name, or has cursor/claude label); both if agent omitted
 *   - Optionally contain the query in title or body
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

function getOriginRepo() {
  try {
    const url = exec("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const match = url.match(/github\.com[:/]([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getCurrentUser() {
  const out = exec(`gh api user -q '.login'`);
  return out.trim();
}

function listOpenPRs(repo) {
  const out = exec(
    `gh pr list --repo ${repo} --state open --limit 200 --json number,headRefName,labels,title,body,author`
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

function matchesQuery(pr, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const title = (pr.title || "").toLowerCase();
  const body = (pr.body || "").toLowerCase();
  return title.includes(q) || body.includes(q);
}

function formatGhError(e, context = "") {
  const stderr = e.stderr ?? e.output?.[2] ?? "";
  const msg = (stderr || e.message || "").trim();
  const prefix = context ? `${context}: ` : "";
  return prefix + (msg || "Unknown error");
}

function enableMergeWhenReady(repo, prNumber) {
  try {
    exec(`gh pr merge --repo ${repo} ${prNumber} --auto`);
    return true;
  } catch (e) {
    const msg = (e.stderr || e.output?.[2] || e.message || "").toLowerCase();
    if (
      (msg.includes("already") && msg.includes("auto")) ||
      msg.includes("already in") ||
      msg.includes("already queued")
    ) {
      return false; // Already enabled - idempotent
    }
    if (msg.includes("draft") && msg.includes("enablepullrequestautomerge")) {
      throw new Error(
        `Cannot enable merge when ready on #${prNumber}: PR is still in draft. Mark it as ready for review first.`
      );
    }
    throw new Error(formatGhError(e, `gh pr merge failed for #${prNumber}`));
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const filtered = args.filter(
    (a) => !["--dry-run", "--all", "--mine"].includes(a)
  );

  let repo;
  let agent = null;
  let query = null;

  if (filtered.length >= 1 && REPO_PATTERN.test(filtered[0])) {
    repo = filtered[0];
    if (filtered.length >= 2 && ["cursor", "claude"].includes(filtered[1].toLowerCase())) {
      agent = filtered[1].toLowerCase();
      query = filtered[2] ?? null;
    } else {
      query = filtered[1] ?? null;
    }
  } else {
    repo = getOriginRepo();
    if (!repo) {
      console.error(`Usage: approval [repo] [agent] [query] [--dry-run] [--all]

  repo      GitHub repo in owner/name format (e.g. acme/cool-project).
            Omit when run inside a git repo to use origin remote.
  agent     Optional: "cursor" or "claude". Omit to match both.
  query     Optional text to match in PR title or body
  --dry-run Show matching PRs without enabling merge when ready
  --all     Include PRs from all authors (default: only yours)

Examples:
  approval                    # Uses origin when run inside a git repo
  approval acme/cool-project
  approval acme/cool-project cursor
  approval acme/cool-project claude "fix login"
  approval acme/cool-project cursor --dry-run
  approval acme/cool-project cursor --all
`);
      process.exit(1);
    }
    if (filtered.length >= 1 && ["cursor", "claude"].includes(filtered[0].toLowerCase())) {
      agent = filtered[0].toLowerCase();
      query = filtered[1] ?? null;
    } else {
      query = filtered[0] ?? null;
    }
  }

  validateRepo(repo);

  const agentLower = agent;
  const mineOnly = !all;

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
    if (!matchesAgent(pr, agentLower) || !matchesQuery(pr, query)) return false;
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
    console.error("(dry run - no changes made)");
    for (const pr of matching) {
      console.log(`#${pr.number} would enable merge when ready`);
    }
  } else {
    for (const pr of matching) {
      const enabled = enableMergeWhenReady(repo, pr.number);
      console.log(`#${pr.number} ${enabled ? "merge when ready enabled" : "already enabled"}`);
    }
  }

  console.error(
    dryRun
      ? "Done."
      : `Done. Processed ${matching.length} PR(s).`
  );
}

try {
  main();
} catch (e) {
  console.error(`\x1b[31merror\x1b[0m ${e.message}`);
  process.exit(1);
}
