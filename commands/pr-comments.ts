/**
 * Lists PR review comments on agent PRs and optionally replies to them.
 * Useful for viewing feedback on Cursor/Claude PRs and responding (e.g. "please fix this").
 *
 * Usage: pr-comments [repo] [pr-number|agent] [options]
 *        Omit repo when run inside a git repo to use origin remote.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getOriginRepo } from "../lib/utils.js";
import { formatCommentBody } from "../lib/format.js";
import type { PR, PRReviewComment } from "../lib/types.js";
import {
  REPO_PATTERN,
  validateRepo,
  validateAgent,
  listOpenPRs,
  listPRReviewComments,
  replyToPRComment,
  resolveReviewThread,
  getAgentForPR,
  formatGhError,
} from "../lib/gh.js";
import { parseStandardFlags } from "../lib/args.js";
import { filterPRs, getUserForDisplay, buildFetchMessage } from "../lib/filters.js";
import type { ExecError } from "../lib/types.js";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

interface CommentWithContext {
  prNumber: number;
  prTitle: string;
  agent: string | null;
  comment: PRReviewComment;
}

function gatherComments(repo: string, prs: PR[]): CommentWithContext[] {
  const result: CommentWithContext[] = [];
  for (const pr of prs) {
    const agent = getAgentForPR(pr);
    const comments = listPRReviewComments(repo, pr.number);
    for (const c of comments) {
      result.push({ prNumber: pr.number, prTitle: pr.title ?? "", agent, comment: c });
    }
  }
  return result;
}

function formatCommentLine(ctx: CommentWithContext, index: number): string {
  const { prNumber, prTitle, agent, comment } = ctx;
  const line = comment.line ?? comment.original_line ?? 0;
  const bodyPreview = (comment.body || "").replace(/\n/g, " ").slice(0, 60);
  const ellipsis = (comment.body || "").length > 60 ? "…" : "";
  const agentPart = agent ? ` ${ANSI.dim}[${agent}]${ANSI.reset}` : "";
  return `${ANSI.cyan}[${index + 1}]${ANSI.reset} #${prNumber} ${comment.path}:${line} – ${bodyPreview}${ellipsis}${agentPart}`;
}

function main(): void {
  const { flags, filtered } = parseStandardFlags(process.argv.slice(2));
  const { mineOnly } = flags;
  const noInteractive =
    filtered.includes("--no-interactive") || !stdout.isTTY;

  const help = `Usage: pr-comments [repo] [pr-number|agent] [options]

  Lists PR review comments on agent PRs and lets you reply (e.g. for Cursor/Claude to fix).
  In interactive mode, select a comment and type a reply to close the loop with the agent.

  repo        GitHub repo in owner/name format. Omit when run inside a git repo.
  pr-number   Specific PR to list comments for.
  agent       Filter PRs by "cursor" or "claude". Omit to match both.

Options:
  --no-interactive   Only list comments, do not enter reply loop
  --mine             Only your PRs (default)
  --all              Include PRs from all authors

Examples:
  pr-comments                         # Uses origin, both agents, interactive
  pr-comments acme/repo 42             # Comments on PR #42
  pr-comments acme/repo cursor        # Cursor PRs only
  pr-comments acme/repo claude --no-interactive
`;

  let repo: string | undefined;
  let prNumber: number | null = null;
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

  const nextArg = afterRepo.find((a) => !a.startsWith("--"));
  if (nextArg) {
    const asNum = parseInt(nextArg, 10);
    if (!Number.isNaN(asNum) && asNum > 0) {
      prNumber = asNum;
    } else if (["cursor", "claude"].includes(nextArg.toLowerCase())) {
      agent = validateAgent(nextArg);
    }
  }

  validateRepo(repo);

  let prs: PR[];

  if (prNumber !== null) {
    const fields = ["number", "headRefName", "labels", "title", "author"];
    const all = listOpenPRs(repo, fields);
    const found = all.find((p) => p.number === prNumber);
    if (!found) {
      console.error(`PR #${prNumber} not found or not open.`);
      process.exit(1);
    }
    prs = [found];
  } else {
    const currentUser = getUserForDisplay(mineOnly);
    console.error(buildFetchMessage(repo, agent, mineOnly, currentUser));
    prs = filterPRs(listOpenPRs(repo, ["number", "headRefName", "labels", "title", "author"]), {
      repo,
      agent,
      mineOnly,
    });
    if (prs.length === 0) {
      console.error("No matching PRs found.");
      process.exit(0);
    }
  }

  const comments = gatherComments(repo, prs);

  if (comments.length === 0) {
    console.error("No PR review comments found.");
    process.exit(0);
  }

  console.error(`Found ${comments.length} comment(s) across ${prs.length} PR(s):\n`);
  for (let i = 0; i < comments.length; i++) {
    console.log(formatCommentLine(comments[i], i));
  }

  if (noInteractive) {
    console.log("\nUse without --no-interactive to select and reply.");
    process.exit(0);
  }

  runInteractiveLoop(repo, comments).catch((e: unknown) => {
    console.error(`\x1b[31merror\x1b[0m ${(e as Error).message}`);
    process.exit(1);
  });
}

async function runInteractiveLoop(repo: string, comments: CommentWithContext[]): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  for (;;) {
    const raw = await rl.question(
      `\n${ANSI.bold}Select comment (1-${comments.length}) or q to quit:${ANSI.reset} `
    );
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "quit" || trimmed === "") {
      rl.close();
      process.exit(0);
    }

    const idx = parseInt(trimmed, 10);
    if (Number.isNaN(idx) || idx < 1 || idx > comments.length) {
      console.error("Invalid selection.");
      continue;
    }

    const ctx = comments[idx - 1];
    const loc = ctx.comment.line ?? ctx.comment.original_line ?? "?";
    console.log(`\n${ANSI.cyan}#${ctx.prNumber} ${ctx.comment.path}:${loc}${ANSI.reset}`);
    console.log(formatCommentBody(ctx.comment.body));
    console.log(`\n${ANSI.dim}${hyperlink(ctx.comment.html_url, "View on GitHub")}${ANSI.reset}\n`);

    const action = await rl.question(
      `${ANSI.bold}[R]eply / [D]ismiss / Enter to skip:${ANSI.reset} `
    );
    const actionKey = action.trim().toLowerCase();

    if (actionKey === "d" || actionKey === "dismiss") {
      try {
        resolveReviewThread(repo, ctx.prNumber, ctx.comment.node_id);
        console.log(`\x1b[32mThread resolved.\x1b[0m`);
      } catch (e: unknown) {
        const err = e as ExecError;
        console.error(`\x1b[31mFailed to resolve thread:\x1b[0m ${formatGhError(err)}`);
      }
    } else if (actionKey === "r" || actionKey === "reply") {
      const reply = await rl.question(`${ANSI.bold}Reply (for agent to act on):${ANSI.reset} `);
      const replyTrimmed = reply.trim();
      if (replyTrimmed.length === 0) {
        console.error("Empty reply, skipping.");
        continue;
      }

      try {
        const mention = ctx.agent || null;
        const body = mention ? `@${mention} ${replyTrimmed}` : replyTrimmed;
        replyToPRComment(repo, ctx.prNumber, ctx.comment.id, body);
        console.log(`\x1b[32mReply posted${mention ? ` (cc @${mention})` : ""}.\x1b[0m`);
      } catch (e: unknown) {
        const err = e as ExecError;
        console.error(`\x1b[31mFailed to post reply:\x1b[0m ${formatGhError(err)}`);
      }
    }
  }
}

main();
