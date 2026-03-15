/**
 * Finds recent agent branches (cursor/*, claude/*) and reruns failed workflow runs.
 *
 * Usage: rerun-failed [repo] [agent] [options]
 *        Omit repo when run inside a git repo to use origin remote.
 *        Omit agent to include both cursor and claude branches.
 */

import { getOriginRepo } from "../lib/utils.js";
import type { WorkflowRun } from "../lib/types.js";
import {
  REPO_PATTERN, validateRepo, validateAgent, gh, getCommitInfoBatch, AGENT_BRANCH_PATTERNS, listBranches,
} from "../lib/gh.js";
import { parseStandardFlags, parseHoursOption, calculateSinceDate } from "../lib/args.js";
import { getUserForDisplay } from "../lib/filters.js";

function listFailedRuns(repo: string, branch: string): WorkflowRun[] {
  try {
    const out = gh(
      "run", "list",
      "--repo", repo,
      "--branch", branch,
      "--status", "failure",
      "--limit", "20",
      "--json", "databaseId,name,conclusion"
    );
    const runs = JSON.parse(out || "[]");
    return Array.isArray(runs) ? (runs as WorkflowRun[]) : [];
  } catch {
    return [];
  }
}

function rerunWorkflow(repo: string, runId: number, dryRun: boolean): boolean {
  if (dryRun) return true;
  try {
    gh("run", "rerun", String(runId), "--repo", repo, "--failed");
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const { flags, filtered } = parseStandardFlags(process.argv.slice(2));
  const { dryRun, mineOnly } = flags;

  const help = `Usage: rerun-failed [repo] [agent] [options]

  repo       GitHub repo in owner/name format (e.g. acme/cool-project).
             Omit when run inside a git repo to use origin remote.
  agent      Optional: "cursor" or "claude" to filter branches. Omit to match both.

Options:
  --hours N   Only branches with commits in last N hours (default: 24)
  --mine      Only your branches (default)
  --all       Include branches from all authors
  --dry-run   Show branches and runs that would be rerun without triggering

Examples:
  rerun-failed                         # Uses origin, both agents
  rerun-failed acme/cool-project       # Both agents
  rerun-failed acme/cool-project cursor
  rerun-failed acme/cool-project claude --hours 48 --dry-run
  rerun-failed acme/cool-project cursor --all
`;

  let repo: string;
  let agent: string | null = null;
  let rest: string[];

  if (filtered.length >= 1 && REPO_PATTERN.test(filtered[0])) {
    repo = filtered[0];
    if (filtered.length >= 2 && ["cursor", "claude"].includes(filtered[1].toLowerCase())) {
      agent = validateAgent(filtered[1]);
      rest = filtered.slice(2);
    } else {
      rest = filtered.slice(1);
    }
  } else {
    repo = getOriginRepo() ?? "";
    if (!repo) {
      console.error(help);
      process.exit(1);
    }
    if (filtered.length >= 1 && ["cursor", "claude"].includes(filtered[0].toLowerCase())) {
      agent = validateAgent(filtered[0]);
      rest = filtered.slice(1);
    } else {
      rest = filtered;
    }
  }

  validateRepo(repo);

  let hours = 24;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--hours" && rest[i + 1]) {
      hours = parseHoursOption(rest, i);
      i++;
    }
  }

  const currentUser = getUserForDisplay(mineOnly);
  const pattern = agent
    ? AGENT_BRANCH_PATTERNS[agent]
    : /^(cursor|claude)\//i;
  const agentLabel = agent ? `${agent}/*` : "cursor/* or claude/*";
  const since = calculateSinceDate(hours);

  if (mineOnly) {
    console.error(`Fetching branches from ${repo} (only yours, @${currentUser})...`);
  } else {
    console.error(`Fetching branches from ${repo} (all authors)...`);
  }
  const allBranches = listBranches(repo);
  const agentBranches = allBranches.filter((b) => pattern.test(b));

  if (agentBranches.length === 0) {
    console.error(`No agent branches (${agentLabel}) found.`);
    process.exit(0);
  }

  // Batch-fetch commit info for all agent branches in a single GraphQL query.
  const commitInfoMap = getCommitInfoBatch(repo, agentBranches, false);

  const recentBranches: string[] = [];
  for (const branch of agentBranches) {
    const info = commitInfoMap.get(branch);
    if (!info) continue;
    const { date, authorLogin } = info;
    if (!date || date < since) continue;
    if (mineOnly) {
      if (authorLogin !== currentUser) {
        console.error(`  Skipping ${branch} (latest commit by @${authorLogin || "unknown"}, not you)`);
        continue;
      }
    }
    recentBranches.push(branch);
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
