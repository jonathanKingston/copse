/**
 * Unified dashboard: full picture of agent PRs across all configured repos.
 * Usage: copse status [options]
 *        Defaults to live TUI mode; use --no-watch for one-shot output.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initializeRuntime } from "../../lib/runtime-init.js";
import { REPO_PATTERN, isInterrupted, setPipeStdio } from "../../lib/gh.js";
import { getUserForDisplay, buildFetchMessage } from "../../lib/filters.js";
import { getConfiguredRepos, loadConfig } from "../../lib/config.js";
import { getOriginRepo } from "../../lib/utils.js";
import { parseStandardFlags, parseTemplatesOption } from "../../lib/args.js";
import { fetchPRsWithStatusSync } from "../../lib/services/status-service.js";
import { isPRWithStatus, WATCH_INTERVAL_MS } from "../../lib/services/status-types.js";
import {
  loadTemplates,
  scaffoldTemplates,
  needsScaffold,
  resolveTemplatesPath,
} from "../../lib/templates.js";
import { createDashboardState, cleanup } from "./state.js";
import {
  renderTable,
  buildTableHeader,
  tableSeparator,
  drawTitle,
  drawFooter,
  rebuildVirtualRows,
  drawAllRows,
  drawCommentInput,
  drawSearchInput,
  drawIssueCreateInput,
} from "./render.js";
import { handleKeypress } from "./keys.js";
import { refresh } from "./actions.js";
import { clampSelection } from "./state.js";

initializeRuntime();

export type { Urgency } from "./state.js";

function runOnce(repos: string[], mineOnly: boolean): void {
  const prs = fetchPRsWithStatusSync({ repos, scope: mineOnly ? "my-stacks" : "all" }).filter(isPRWithStatus);
  renderTable(prs, repos.length === 1);
}

function runWatch(
  repos: string[],
  mineOnly: boolean,
  templatesMap: Map<string, string>,
  cursorApiKey: string | null
): void {
  const state = createDashboardState({ repos, mineOnly, templatesMap, cursorApiKey });

  setPipeStdio(true);

  process.on("SIGINT", () => cleanup(state));

  process.on("SIGWINCH", () => {
    rebuildVirtualRows(state);
    clampSelection(state);
    process.stdout.write("\x1b[2J\x1b[H");
    drawTitle(state);
    process.stdout.write(`\x1b[3;1H${buildTableHeader(state.singleRepo)}`);
    process.stdout.write(`\x1b[4;1H${tableSeparator()}`);
    drawAllRows(state);
    if (state.commentInputMode) drawCommentInput(state);
    else if (state.searchMode) drawSearchInput(state);
    else if (state.issueCreateMode) drawIssueCreateInput(state);
    else drawFooter(state);
  });

  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
  drawTitle(state);
  process.stdout.write("\n\n");
  console.log(buildTableHeader(state.singleRepo));
  console.log(tableSeparator());
  process.stdout.write(`\x1b[${state.ROW_START};1H\x1b[2mLoading…\x1b[0m`);
  drawFooter(state);

  if (state.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    process.stdin.on("data", (key: string) => {
      handleKeypress(state, key);
    });
  }

  refresh(state);

  function loop(): void {
    if (isInterrupted()) { cleanup(state); return; }
    if (!state.busy && !state.ciUpdatePending) refresh(state);
    setTimeout(loop, WATCH_INTERVAL_MS);
  }
  setTimeout(loop, WATCH_INTERVAL_MS);
}

async function main(): Promise<void> {
  const { flags, filtered } = parseStandardFlags(process.argv.slice(2));
  const { mineOnly } = flags;
  const noWatch = filtered.includes("--no-watch");
  const watch = !noWatch && !!process.stdout.isTTY;
  const filteredArgs = filtered.filter((a) => a !== "--watch" && a !== "--no-watch");

  const help = `Usage: status [options]

  Unified dashboard across all configured repos. Shows every open agent PR with
  CI status, review state, conflicts, age, comments, and merge-readiness.

  Uses ~/.copserc or .copserc when present: { "repos": ["owner/name", ...] }
  Falls back to the origin remote when run inside a git repo (including submodules).

  Defaults to live TUI mode when connected to a terminal.

Options:
  --no-watch   One-shot table output (no TUI)
  --templates PATH  Comment template directory (default: ~/.copse/comment-templates)
  --mine       Only your PRs (default)
  --all        Include PRs from all authors

TUI keys:
  ↑↓/jk navigate  ⏎ expand  [d]iff  [p]artifacts  [D]download  [/]filter  [f]mine/all  [o]pen  [c]heckout  [C]omment/reply  Space select  [T]emplate batch  [i]ssue
  [r]erun  [u]pdate main  [a]pprove  [m]erge when ready
  [R]erun all  [U]pdate all  [q]uit
`;

  let repos: string[] = [];

  if (filteredArgs.length >= 1 && REPO_PATTERN.test(filteredArgs[0])) {
    repos = [filteredArgs[0]];
  } else {
    const configured = getConfiguredRepos();
    if (configured && configured.length > 0) {
      repos = configured;
    } else {
      const origin = getOriginRepo();
      if (origin) {
        repos = [origin];
      } else {
        console.error(help);
        console.error("\nNo repos configured. Run 'copse init' to set up ~/.copserc or run inside a git repo.");
        process.exit(1);
      }
    }
  }

  const currentUser = getUserForDisplay(mineOnly);
  const repoDesc = repos.length === 1 ? repos[0] : `${repos.length} repos`;
  console.error(buildFetchMessage(repoDesc, null, mineOnly, currentUser));
  console.error(`Scanning ${repos.length} repo(s)...\n`);

  if (watch) {
    let templatesMap = new Map<string, string>();
    let cursorApiKey: string | null = null;
    try {
      const templatesFromFlag = parseTemplatesOption(process.argv.slice(2));
      const config = loadConfig();
      cursorApiKey = config?.cursorApiKey?.trim() || null;
      const templatesPath = resolveTemplatesPath(
        templatesFromFlag ?? null,
        config?.commentTemplates ?? null
      );
      templatesMap = loadTemplates(templatesPath);
      if (templatesMap.size === 0 && needsScaffold(templatesPath) && stdout.isTTY) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        const answer = await rl.question(
          `\nNo templates found. Create with starter templates? [y/n]: `
        );
        rl.close();
        if (answer.trim().toLowerCase() === "y") {
          scaffoldTemplates(templatesPath);
          templatesMap = loadTemplates(templatesPath);
        }
      }
    } catch (e: unknown) {
      if ((e as Error).message?.includes("--templates")) {
        console.error((e as Error).message);
        process.exit(1);
      }
    }
    runWatch(repos, mineOnly, templatesMap, cursorApiKey);
  } else {
    runOnce(repos, mineOnly);
  }
}

main().catch((e: unknown) => {
  console.error(`\x1b[31merror\x1b[0m ${(e as Error).message}`);
  process.exit(1);
});
