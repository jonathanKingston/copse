/**
 * Lists open agent PRs and their test/CI status: failed workflow runs and reruns.
 *
 * Usage: pr-status [repo] [agent] [options]
 *        Omit repo when run inside a git repo to use origin remote.
 */

import { getOriginRepo, hyperlink, getTerminalColumns } from "../lib/utils.js";
import type { WorkflowRun } from "../lib/types.js";
import {
  REPO_PATTERN, validateRepo, listOpenPRs, listWorkflowRuns,
} from "../lib/gh.js";
import { parseStandardFlags } from "../lib/args.js";
import { filterPRs, getUserForDisplay, buildFetchMessage } from "../lib/filters.js";

function main(): void {
  const { flags, filtered } = parseStandardFlags(process.argv.slice(2));
  const { mineOnly } = flags;

  const help = `Usage: pr-status [repo] [agent] [options]

  repo       GitHub repo in owner/name format (e.g. acme/cool-project).
             Omit when run inside a git repo to use origin remote.
  agent      Optional: "cursor" or "claude" to filter PRs. Omit to match both.

Options:
  --mine     Only your PRs (default)
  --all      Include PRs from all authors

Examples:
  pr-status                    # Uses origin when run inside a git repo
  pr-status acme/cool-project
  pr-status acme/cool-project cursor
  pr-status acme/cool-project claude --all
`;

  let repo: string | undefined;
  let agent: string | null = null;
  let afterRepo: string[];

  if (filtered.length >= 1 && REPO_PATTERN.test(filtered[0])) {
    repo = filtered[0];
    afterRepo = filtered.slice(1);
  } else {
    repo = getOriginRepo() ?? undefined;
    if (!repo) {
      console.error(help);
      process.exit(1);
    }
    afterRepo = filtered;
  }

  if (
    afterRepo.length >= 1 &&
    !afterRepo[0].startsWith("--") &&
    ["cursor", "claude"].includes(afterRepo[0].toLowerCase())
  ) {
    agent = afterRepo[0].toLowerCase();
  }

  validateRepo(repo);

  const currentUser = getUserForDisplay(mineOnly);
  console.error(buildFetchMessage(repo, agent, mineOnly, currentUser));

  const prs = listOpenPRs(repo, ["number", "headRefName", "labels", "title", "author"]);
  const matching = filterPRs(prs, { repo, agent, mineOnly });

  if (matching.length === 0) {
    console.error("No matching PRs found.");
    process.exit(0);
  }

  console.error(`Found ${matching.length} matching PR(s)\n`);

  const columns = getTerminalColumns();

  for (const pr of matching) {
    const runs = listWorkflowRuns(repo, pr.headRefName);
    const failed = runs.filter((r) => r.conclusion === "failure");

    const prUrl = `https://github.com/${repo}/pull/${pr.number}`;
    const heading = `#${pr.number} ${pr.headRefName}`;
    console.log(hyperlink(prUrl, heading));

    const indent = 2;
    const maxTitleWidth = Math.max(20, columns - indent);
    const titleShort = (pr.title || "").slice(0, maxTitleWidth);
    const suffix = (pr.title || "").length > maxTitleWidth ? "…" : "";
    console.log(`  ${titleShort}${suffix}`);
    console.log(`  ${prUrl}`);

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
      const byWorkflow = new Map<string, WorkflowRun[]>();
      for (const r of failed) {
        const key = r.name || r.displayTitle || `Run #${r.databaseId}`;
        if (!byWorkflow.has(key)) {
          byWorkflow.set(key, []);
        }
        byWorkflow.get(key)!.push(r);
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
