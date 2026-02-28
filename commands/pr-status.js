#!/usr/bin/env node

/**
 * Lists open agent PRs and their test/CI status: failed workflow runs and reruns.
 *
 * Usage: pr-status <repo> [agent] [options]
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

function listWorkflowRuns(repo, branch) {
  try {
    const branchEsc = branch.replace(/"/g, '\\"');
    const out = exec(
      `gh run list --repo ${repo} --branch "${branchEsc}" --limit 100 --json databaseId,name,conclusion,attempt,status,displayTitle`
    );
    const runs = JSON.parse(out || "[]");
    return Array.isArray(runs) ? runs : [];
  } catch (e) {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const filtered = args.filter((a) => a !== "--all");

  const help = `Usage: pr-status <repo> [agent] [options]

  repo       GitHub repo in owner/name format (e.g. acme/cool-project)
  agent      Optional: "cursor" or "claude" to filter PRs. Omit to match both.

Options:
  --mine     Only your PRs (default)
  --all      Include PRs from all authors

Examples:
  pr-status acme/cool-project
  pr-status acme/cool-project cursor
  pr-status acme/cool-project claude --all
`;

  if (filtered.length < 1) {
    console.error(help);
    process.exit(1);
  }

  const repo = filtered[0];
  validateRepo(repo);
  let agent = null;
  const rest = filtered.slice(1);

  if (
    rest.length >= 1 &&
    !rest[0].startsWith("--") &&
    ["cursor", "claude"].includes(rest[0].toLowerCase())
  ) {
    agent = rest[0].toLowerCase();
  }

  const mineOnly = !all;
  let currentUser = null;
  if (mineOnly) {
    currentUser = getCurrentUser();
    console.error(
      `Fetching open agent PRs from ${repo}${agent ? ` (agent: ${agent})` : " (cursor + claude)"} (only yours, @${currentUser})...`
    );
  } else {
    console.error(
      `Fetching open agent PRs from ${repo}${agent ? ` (agent: ${agent})` : " (cursor + claude)"} (all authors)...`
    );
  }

  const prs = listOpenPRs(repo);
  const matching = prs.filter((pr) => {
    if (!matchesAgent(pr, agent)) return false;
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

  console.error(`Found ${matching.length} matching PR(s)\n`);

  for (const pr of matching) {
    const runs = listWorkflowRuns(repo, pr.headRefName);
    const failed = runs.filter((r) => r.conclusion === "failure");

    const titleShort = (pr.title || "").slice(0, 60);
    const suffix = (pr.title || "").length > 60 ? "…" : "";
    console.log(`#${pr.number} ${pr.headRefName}`);
    console.log(`  ${titleShort}${suffix}`);
    console.log(`  https://github.com/${repo}/pull/${pr.number}`);

    if (failed.length === 0) {
      const inProgress = runs.filter(
        (r) => r.status === "in_progress" || r.status === "queued" || r.status === "requested"
      );
      if (inProgress.length > 0) {
        console.log(`  CI: ${inProgress.length} run(s) in progress`);
      } else {
        const lastSuccess = runs.find((r) => r.conclusion === "success");
        console.log(`  CI: ${lastSuccess ? "passing" : "no runs"}`);
      }
    } else {
      const byWorkflow = new Map();
      for (const r of failed) {
        const key = r.name || r.displayTitle || `Run #${r.databaseId}`;
        if (!byWorkflow.has(key)) {
          byWorkflow.set(key, []);
        }
        byWorkflow.get(key).push(r);
      }
      for (const [workflow, workflowRuns] of byWorkflow) {
        const attempts = workflowRuns
          .map((r) => `attempt ${r.attempt ?? 1}`)
          .join(", ");
        const runIds = workflowRuns.map((r) => r.databaseId).join(", ");
        const rerunCount = workflowRuns.filter((r) => (r.attempt ?? 1) > 1).length;
        const rerunNote = rerunCount > 0 ? ` (${rerunCount} rerun${rerunCount > 1 ? "s" : ""})` : "";
        console.log(`  FAILED: ${workflow} [${attempts}] run #${runIds}${rerunNote}`);
      }
    }
    console.log("");
  }
}

main();
