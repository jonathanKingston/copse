/**
 * Merges main into open PR branches matching repo and agent filter.
 * Keeps PRs up to date with the latest main.
 *
 * Usage: update-main <repo> <agent> [options]
 */

import type { ExecError, MergeResult } from "../lib/types.js";
import { initializeRuntime } from "../lib/runtime-init.js";
import {
  validateRepo, gh, listOpenPRs,
} from "../lib/gh.js";
import { parseCliArgs } from "../lib/args.js";
import { filterPRs, getUserForDisplay, buildFetchMessage } from "../lib/filters.js";

initializeRuntime();

function mergeMainIntoBranch(repo: string, headRef: string, baseRef: string, dryRun: boolean): MergeResult {
  if (dryRun) return { ok: true, skipped: true };
  try {
    gh("api", `repos/${repo}/merges`, "-f", `base=${headRef}`, "-f", `head=${baseRef}`);
    return { ok: true };
  } catch (e: unknown) {
    const err = e as ExecError;
    const msg = (err.stderr || err.message || "").toLowerCase();
    if (msg.includes("nothing to merge") || msg.includes("already up to date")) {
      return { ok: true, alreadyUpToDate: true };
    }
    return { ok: false, error: err.message };
  }
}

function main(): void {
  const { flags, positionals, options } = parseCliArgs(process.argv.slice(2), {
    repoRequired: true,
    defaultBase: "main",
    helpText: `Usage: update-main <repo> [agent] [options]

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
`,
  });
  const { dryRun, mineOnly } = flags;
  const { repo, agent } = positionals;
  const baseBranch = options.base;

  validateRepo(repo);

  const currentUser = getUserForDisplay(mineOnly);
  console.error(buildFetchMessage(repo, agent, mineOnly, currentUser));
  
  const prs = listOpenPRs(repo, ["number", "headRefName", "labels", "title", "author"]);
  const matching = filterPRs(prs, { repo, agent, mineOnly });

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
