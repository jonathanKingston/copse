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

import { initializeRuntime } from "../lib/runtime-init.js";
import { getOriginRepo } from "../lib/utils.js";
import type { ExecError } from "../lib/types.js";
import {
  validateRepo, gh, formatGhError, listOpenPRs,
} from "../lib/gh.js";
import { parseCliArgs } from "../lib/args.js";
import { filterPRs, getUserForDisplay, buildFetchMessage } from "../lib/filters.js";

initializeRuntime();

const autoMergeStrategyCache = new Map<string, string>();

function getAutoMergeStrategy(repo: string): string {
  const cached = autoMergeStrategyCache.get(repo);
  if (cached) {
    return cached;
  }

  const out = gh(
    "api",
    `repos/${repo}`,
    "-q",
    "{allowSquashMerge: .allow_squash_merge, allowMergeCommit: .allow_merge_commit, allowRebaseMerge: .allow_rebase_merge}"
  );
  const settings = JSON.parse(out) as {
    allowSquashMerge?: boolean;
    allowMergeCommit?: boolean;
    allowRebaseMerge?: boolean;
  };
  const strategy = settings.allowSquashMerge
    ? "--squash"
    : settings.allowMergeCommit
      ? "--merge"
      : settings.allowRebaseMerge
        ? "--rebase"
        : null;
  if (!strategy) {
    throw new Error(`Cannot enable auto-merge for ${repo}: repository does not allow squash, merge, or rebase merges.`);
  }
  autoMergeStrategyCache.set(repo, strategy);
  return strategy;
}

function enableMergeWhenReady(repo: string, prNumber: number): boolean {
  try {
    gh("pr", "merge", "--repo", repo, String(prNumber), "--auto", getAutoMergeStrategy(repo));
    return true;
  } catch (e: unknown) {
    const err = e as ExecError;
    const msg = (err.stderr || err.output?.[2] || err.message || "").toLowerCase();
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
    if (msg.includes("--merge, --rebase, or --squash required")) {
      throw new Error(
        `Cannot enable merge when ready on #${prNumber}: GitHub CLI needs an explicit merge strategy for this repository.`
      );
    }
    throw new Error(formatGhError(err, `gh pr merge failed for #${prNumber}`));
  }
}

function main(): void {
  const { flags, positionals } = parseCliArgs(process.argv.slice(2), {
    repoRequired: false,
    inferRepo: getOriginRepo,
    helpText: `Usage: approval [repo] [agent] [query] [--dry-run] [--all]

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
`,
  });
  const { dryRun, mineOnly } = flags;
  const { repo, agent, query } = positionals;

  validateRepo(repo);

  const currentUser = getUserForDisplay(mineOnly);
  console.error(buildFetchMessage(repo, agent, mineOnly, currentUser));
  
  const prs = listOpenPRs(repo, ["number", "headRefName", "labels", "title", "body", "author"]);
  const matching = filterPRs(prs, { repo, agent, mineOnly, query });

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
} catch (e: unknown) {
  console.error(`\x1b[31merror\x1b[0m ${(e as Error).message}`);
  process.exit(1);
}
