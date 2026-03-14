/**
 * Unified dashboard: full picture of agent PRs across all configured repos.
 * Usage: copse status [options]
 *        Defaults to live TUI mode; use --no-watch for one-shot output.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFile as execFileCb } from "child_process";
import {
  REPO_PATTERN,
  ghQuietAsync,
  listPRReviewCommentsAsync,
  listPRFilesAsync,
  isInterrupted,
  setPipeStdio,
} from "../lib/gh.js";
import type { PRReviewComment, PRChangedFile } from "../lib/types.js";
import { getUserForDisplay, buildFetchMessage } from "../lib/filters.js";
import { formatCommentBody, wrapAnsiText } from "../lib/format.js";
import { getConfiguredRepos, loadConfig } from "../lib/config.js";
import { getOriginRepo } from "../lib/utils.js";
import { parseStandardFlags, parseTemplatesOption } from "../lib/args.js";
import { fetchPRsWithStatus, fetchPRsWithStatusSync } from "../lib/services/status-service.js";
import {
  approvePullRequest,
  createIssueWithAgentComment,
  enableMergeWhenReady,
  mergeBaseIntoBranch,
  postPullRequestComment,
  postPullRequestReply,
  rerunFailedWorkflowRuns,
} from "../lib/services/status-actions.js";
import { STALE_DAYS, WATCH_INTERVAL_MS, type PRWithStatus } from "../lib/services/status-types.js";
import {
  loadTemplates,
  scaffoldTemplates,
  needsScaffold,
  resolveTemplatesPath,
} from "../lib/templates.js";

function execAsync(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(command, args, { encoding: "utf-8", timeout: 30_000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout);
    });
  });
}

const BULK_COOLDOWN_MS = 2_000;

export type Urgency = "red" | "amber" | "green";

function getUrgency(pr: PRWithStatus): Urgency {
  if (pr.ciStatus === "fail" || pr.conflicts) return "red";
  if (pr.stale || pr.reviewDecision === "CHANGES_REQUESTED" || pr.ciStatus === "pending") return "amber";
  return "green";
}

function matchesSearch(pr: PRWithStatus, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const searchable = [
    pr.repo,
    String(pr.number),
    pr.agent ?? "",
    pr.ciStatus,
    pr.reviewDecision.toLowerCase().replace(/_/g, " "),
    pr.conflicts ? "conflicts" : "",
    pr.autoMerge ? "merge when ready" : "",
    `${pr.ageDays}d`,
    pr.title,
    pr.author.login,
    pr.headRefName,
  ];
  return searchable.some(f => f.toLowerCase().includes(q));
}


const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  amber: "\x1b[33m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function hyperlink(url: string, text: string): string {
  if (!process.stdout.isTTY) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "").length;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function truncatePlain(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return "…";
  return text.slice(0, maxLen - 1) + "…";
}

function formatCI(pr: PRWithStatus): string {
  if (pr.ciStatus === "pass") return `${ANSI.green}✓${ANSI.reset}`;
  if (pr.ciStatus === "fail") return `${ANSI.red}✗${ANSI.reset}`;
  if (pr.ciStatus === "pending") return `${ANSI.amber}…${ANSI.reset}`;
  return `${ANSI.dim}—${ANSI.reset}`;
}

function formatReview(pr: PRWithStatus): string {
  const r = pr.reviewDecision;
  if (r === "APPROVED") return `${ANSI.green}✓${ANSI.reset}`;
  if (r === "CHANGES_REQUESTED") return `${ANSI.amber}!${ANSI.reset}`;
  return `${ANSI.dim}○${ANSI.reset}`;
}

function formatAutoMerge(pr: PRWithStatus): string {
  return pr.autoMerge ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.dim}—${ANSI.reset}`;
}

function formatComments(pr: PRWithStatus): string {
  if (pr.commentCount === 0) return `${ANSI.dim}—${ANSI.reset}`;
  return `${ANSI.amber}${pr.commentCount}${ANSI.reset}`;
}

const FIXED_COLS_WIDTH = 39;
const REPO_COL_WIDTH = 19;

function formatPRRow(pr: PRWithStatus, singleRepo: boolean): string {
  const columns = process.stdout.columns || 80;
  const prefixWidth = singleRepo ? FIXED_COLS_WIDTH : FIXED_COLS_WIDTH + REPO_COL_WIDTH;
  const titleMaxWidth = Math.max(20, columns - prefixWidth);

  const urgency = getUrgency(pr);
  const color = ANSI[urgency];
  const repoPart = singleRepo
    ? ""
    : pad(pr.repo.length > 18 ? pr.repo.slice(0, 15) + "…" : pr.repo, 18) + " ";
  const agent = (pr.agent ?? "?").padEnd(7);
  const prUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const prNum = hyperlink(prUrl, `#${String(pr.number).padEnd(4)}`);
  const ci = formatCI(pr);
  const rev = formatReview(pr);
  const con = pr.conflicts ? `${ANSI.red}✗${ANSI.reset}` : `${ANSI.green}—${ANSI.reset}`;
  const mwr = formatAutoMerge(pr);
  const ageRaw = `${pr.ageDays}d`;
  const age = pr.ageDays >= STALE_DAYS ? `${ANSI.amber}${ageRaw}${ANSI.reset}` : ageRaw;
  const cmt = formatComments(pr);
  const titleShort = pr.title.slice(0, titleMaxWidth) + (pr.title.length > titleMaxWidth ? "…" : "");
  return `${color}${repoPart}${prNum} ${agent} ${ci}   ${rev}   ${con}   ${mwr}   ${pad(age, 4)} ${pad(cmt, 3)} ${titleShort}${ANSI.reset}`;
}

function headerLink(label: string, description: string): string {
  return hyperlink(`https://copse.dev#${description}`, label);
}

function buildTableHeader(singleRepo: boolean): string {
  const repoPart = singleRepo ? "" : pad(headerLink("REPO", "repository"), 19);
  return `${ANSI.bold}${repoPart}${[
    pad(headerLink("#", "pr-number"), 6),
    pad(headerLink("AGENT", "agent-cursor/claude/copilot"), 8),
    pad(headerLink("CI", "continuous-integration"), 4),
    pad(headerLink("REV", "review-status"), 4),
    pad(headerLink("CON", "merge-conflicts"), 4),
    pad(headerLink("MWR", "merge-when-ready"), 4),
    pad(headerLink("AGE", "days-since-pr-opened"), 5),
    pad(headerLink("CMT", "unresolved-review-comments"), 4),
    headerLink("TITLE", "pr-title"),
  ].join("")}${ANSI.reset}`;
}

function tableSeparator(): string {
  return "-".repeat(process.stdout.columns || 80);
}

function renderTable(prs: PRWithStatus[], singleRepo: boolean): void {
  if (prs.length === 0) {
    console.log("No agent PRs found.");
    return;
  }

  console.log(buildTableHeader(singleRepo));
  console.log(tableSeparator());
  for (const pr of prs) {
    console.log(formatPRRow(pr, singleRepo));
  }
}

function runOnce(repos: string[], mineOnly: boolean): void {
  const prs = fetchPRsWithStatusSync({ repos, mineOnly });
  renderTable(prs, repos.length === 1);
}

function runWatch(
  repos: string[],
  mineOnly: boolean,
  templatesMap: Map<string, string>,
  cursorApiKey: string | null
): void {
  const singleRepo = repos.length === 1;
  const TITLE = "copse status";
  const ROW_START = 5;
  let mineOnlyFilter = mineOnly;
  let currentPRs: PRWithStatus[] = [];
  let statusMsg = "";
  let busy = false;
  let selectedIndex = 0;
  let ciGeneration = 0;
  let ciUpdatePending = false;
  const isTTY = !!process.stdin.isTTY;

  type VirtualRow =
    | { kind: "pr"; prIndex: number }
    | { kind: "comment"; prIndex: number; commentIndex: number }
    | { kind: "comment-body"; prIndex: number; commentIndex: number; line: string }
    | { kind: "diff-file"; prIndex: number; fileIndex: number }
    | { kind: "diff-patch-line"; prIndex: number; fileIndex: number; line: string }
    | { kind: "info"; prIndex: number; text: string };

  let virtualRows: VirtualRow[] = [];
  let expandedPRIndex: number | null = null;
  let expandedPRNumber: number | null = null;
  let expandedComments: PRReviewComment[] = [];
  let expandedFiles: PRChangedFile[] = [];
  let expandedLoading = false;
  let expandedMode: "comments" | "diff" = "comments";
  const DETAIL_MAX_LINES = 10;

  let commentInputMode = false;
  let templatePickerMode = false;
  let commentBuffer = "";
  let commentTarget:
    | { kind: "pr"; pr: PRWithStatus }
    | { kind: "comment"; pr: PRWithStatus; comment: PRReviewComment }
    | null = null;

  let searchMode = false;
  let searchBuffer = "";
  let searchQuery = "";
  let preSearchQuery = "";
  let scrollOffset = 0;

  let issueCreateMode = false;
  let issueCreateStep: "title" | "body" | "template" = "title";
  let issueTitleBuffer = "";
  let issueBodyBuffer = "";
  let issueTemplateChoice = -1;
  let issueTargetRepo: string | null = null;

  setPipeStdio(true);

  function getViewportHeight(): number {
    const termRows = process.stdout.rows || 24;
    return Math.max(1, termRows - ROW_START - 2);
  }

  function ensureVisible(): void {
    const vh = getViewportHeight();
    if (selectedIndex < scrollOffset) {
      scrollOffset = selectedIndex;
    } else if (selectedIndex >= scrollOffset + vh) {
      scrollOffset = selectedIndex - vh + 1;
    }
    scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, virtualRows.length - vh)));
  }

  function cleanup(): void {
    if (isTTY) try { process.stdin.setRawMode(false); } catch {}
    process.stdout.write("\x1b[?25h\n");
    process.exit(0);
  }

  process.on("SIGINT", cleanup);

  process.on("SIGWINCH", () => {
    rebuildVirtualRows();
    clampSelection();
    process.stdout.write("\x1b[2J\x1b[H");
    drawTitle();
    process.stdout.write(`\x1b[3;1H${buildTableHeader(singleRepo)}`);
    process.stdout.write(`\x1b[4;1H${tableSeparator()}`);
    drawAllRows();
    if (commentInputMode) drawCommentInput();
    else if (searchMode) drawSearchInput();
    else if (issueCreateMode) drawIssueCreateInput();
    else drawFooter();
  });

  function rebuildVirtualRows(): void {
    virtualRows = [];
    for (let i = 0; i < currentPRs.length; i++) {
      if (!matchesSearch(currentPRs[i], searchQuery)) continue;
      virtualRows.push({ kind: "pr", prIndex: i });
      if (expandedPRIndex === i) {
        if (expandedLoading) {
          const loadLabel = expandedMode === "diff" ? "files" : "comments";
          virtualRows.push({ kind: "info", prIndex: i,
            text: `  ${ANSI.dim}Loading ${loadLabel} for #${currentPRs[i].number}…${ANSI.reset}` });
        } else if (expandedMode === "diff") {
          if (expandedFiles.length === 0) {
            virtualRows.push({ kind: "info", prIndex: i,
              text: `  ${ANSI.dim}No changed files on #${currentPRs[i].number}${ANSI.reset}` });
          } else {
            const totalAdd = expandedFiles.reduce((s, f) => s + f.additions, 0);
            const totalDel = expandedFiles.reduce((s, f) => s + f.deletions, 0);
            virtualRows.push({ kind: "info", prIndex: i,
              text: `  ${ANSI.dim}${expandedFiles.length} file(s) changed, ${ANSI.green}+${totalAdd}${ANSI.reset} ${ANSI.red}-${totalDel}${ANSI.reset}` });
            for (let j = 0; j < expandedFiles.length; j++) {
              virtualRows.push({ kind: "diff-file", prIndex: i, fileIndex: j });
            }
          }
        } else {
          if (expandedComments.length === 0) {
            virtualRows.push({ kind: "info", prIndex: i,
              text: `  ${ANSI.dim}No unresolved comments on #${currentPRs[i].number}${ANSI.reset}` });
          } else {
            const columns = process.stdout.columns || 80;
            const bodyIndent = "      ";
            const maxComments = Math.min(expandedComments.length, DETAIL_MAX_LINES);
            for (let j = 0; j < maxComments; j++) {
              virtualRows.push({ kind: "comment", prIndex: i, commentIndex: j });
              const formatted = formatCommentBody(expandedComments[j].body);
              const bodyLines = wrapAnsiText(formatted, columns, bodyIndent);
              for (const line of bodyLines) {
                virtualRows.push({ kind: "comment-body", prIndex: i, commentIndex: j, line });
              }
              if (j < maxComments - 1) {
                virtualRows.push({ kind: "info", prIndex: i, text: "" });
              }
            }
            if (expandedComments.length > maxComments) {
              virtualRows.push({ kind: "info", prIndex: i,
                text: `    ${ANSI.dim}${expandedComments.length - maxComments} more — press [o] to view on GitHub${ANSI.reset}` });
            }
          }
        }
      }
    }
  }

  function formatCommentRow(comment: PRReviewComment): string {
    const loc = String(comment.line ?? comment.original_line ?? "?");
    const pathLoc = `${comment.path}:${loc}`;
    return `    ${ANSI.bold}${comment.user.login}${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${pathLoc}`;
  }

  function formatDiffFileRow(file: PRChangedFile): string {
    const statusChar = file.status === "added" ? "A" : file.status === "removed" ? "D" : file.status === "renamed" ? "R" : "M";
    const statusColor = file.status === "added" ? ANSI.green : file.status === "removed" ? ANSI.red : ANSI.amber;
    const filename = file.status === "renamed" && file.previous_filename
      ? `${file.previous_filename} → ${file.filename}`
      : file.filename;
    return `    ${statusColor}${statusChar}${ANSI.reset} ${filename} ${ANSI.green}+${file.additions}${ANSI.reset} ${ANSI.red}-${file.deletions}${ANSI.reset}`;
  }

  function highlightRow(row: string): string {
    return `\x1b[7m${row.replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m")}\x1b[0m`;
  }

  function drawRow(vIndex: number): void {
    if (vIndex < 0 || vIndex >= virtualRows.length) return;
    const vh = getViewportHeight();
    if (vIndex < scrollOffset || vIndex >= scrollOffset + vh) return;
    const screenRow = ROW_START + (vIndex - scrollOffset);
    const vr = virtualRows[vIndex];
    let row: string;
    if (vr.kind === "pr") {
      row = formatPRRow(currentPRs[vr.prIndex], singleRepo);
    } else if (vr.kind === "comment") {
      row = formatCommentRow(expandedComments[vr.commentIndex]);
    } else if (vr.kind === "comment-body") {
      row = vr.line;
    } else if (vr.kind === "diff-file") {
      row = formatDiffFileRow(expandedFiles[vr.fileIndex]);
    } else if (vr.kind === "diff-patch-line") {
      row = vr.line;
    } else {
      row = vr.text;
    }
    if (vIndex === selectedIndex) row = highlightRow(row);
    process.stdout.write(`\x1b[${screenRow};1H\x1b[2K${row}`);
  }

  function drawAllRows(): void {
    const vh = getViewportHeight();
    const end = Math.min(virtualRows.length, scrollOffset + vh);
    for (let i = scrollOffset; i < end; i++) drawRow(i);
    const usedLines = end - scrollOffset;
    for (let i = usedLines; i < vh; i++) {
      process.stdout.write(`\x1b[${ROW_START + i};1H\x1b[2K`);
    }
  }

  function clearStaleRows(_oldLen: number): void {
    const vh = getViewportHeight();
    const usedLines = Math.max(0, Math.min(virtualRows.length, scrollOffset + vh) - scrollOffset);
    for (let i = usedLines; i < vh; i++) {
      process.stdout.write(`\x1b[${ROW_START + i};1H\x1b[2K`);
    }
  }

  function collapseDetail(): void {
    if (expandedPRIndex === null) return;
    const oldLen = virtualRows.length;
    expandedPRIndex = null;
    expandedPRNumber = null;
    expandedComments = [];
    expandedFiles = [];
    expandedLoading = false;
    expandedMode = "comments";
    rebuildVirtualRows();
    clampSelection();
    drawAllRows();
    clearStaleRows(oldLen);
    drawFooter();
  }

  function handleToggleExpand(): void {
    if (virtualRows.length === 0) return;
    const vr = virtualRows[selectedIndex];
    if (!vr) return;
    const prIndex = vr.prIndex;

    if (expandedPRIndex === prIndex) {
      const prVi = virtualRows.findIndex(v => v.kind === "pr" && v.prIndex === prIndex);
      if (prVi !== -1) selectedIndex = prVi;
      collapseDetail();
      return;
    }

    const oldLen = virtualRows.length;
    expandedPRIndex = prIndex;
    expandedPRNumber = currentPRs[prIndex]?.number ?? null;
    expandedComments = [];
    expandedFiles = [];
    expandedLoading = true;
    expandedMode = "comments";
    rebuildVirtualRows();
    drawAllRows();
    clearStaleRows(oldLen);
    drawFooter();

    const pr = currentPRs[prIndex];
    if (!pr) return;

    (async () => {
      try {
        const comments = await listPRReviewCommentsAsync(pr.repo, pr.number);
        if (expandedPRNumber !== pr.number) return;
        expandedComments = comments;
      } catch {
        expandedComments = [];
      } finally {
        expandedLoading = false;
      }
      if (expandedPRNumber === pr.number) {
        const oldLen2 = virtualRows.length;
        rebuildVirtualRows();
        drawAllRows();
        clearStaleRows(oldLen2);
        drawFooter();
      }
    })();
  }

  function handleToggleDiff(): void {
    if (virtualRows.length === 0) return;
    const vr = virtualRows[selectedIndex];
    if (!vr) return;
    const prIndex = vr.prIndex;

    // If already expanded in diff mode for this PR, collapse
    if (expandedPRIndex === prIndex && expandedMode === "diff") {
      const prVi = virtualRows.findIndex(v => v.kind === "pr" && v.prIndex === prIndex);
      if (prVi !== -1) selectedIndex = prVi;
      collapseDetail();
      return;
    }

    // If already expanded in comments mode, switch to diff mode
    const oldLen = virtualRows.length;
    expandedPRIndex = prIndex;
    expandedPRNumber = currentPRs[prIndex]?.number ?? null;
    expandedFiles = [];
    expandedComments = [];
    expandedLoading = true;
    expandedMode = "diff";
    rebuildVirtualRows();
    drawAllRows();
    clearStaleRows(oldLen);
    drawFooter();

    const pr = currentPRs[prIndex];
    if (!pr) return;

    (async () => {
      try {
        const files = await listPRFilesAsync(pr.repo, pr.number);
        if (expandedPRNumber !== pr.number) return;
        expandedFiles = files;
      } catch {
        expandedFiles = [];
      } finally {
        expandedLoading = false;
      }
      if (expandedPRNumber === pr.number) {
        const oldLen2 = virtualRows.length;
        rebuildVirtualRows();
        drawAllRows();
        clearStaleRows(oldLen2);
        drawFooter();
      }
    })();
  }

  function handleCheckout(): void {
    const pr = selectedPR();
    if (busy || !pr) return;

    const localRepo = getOriginRepo();
    if (!localRepo || localRepo !== pr.repo) {
      statusMsg = `${ANSI.red}Cannot checkout: not in the ${pr.repo} repository${ANSI.reset}`;
      drawFooter();
      return;
    }

    busy = true;
    statusMsg = `${ANSI.amber}Checking git status…${ANSI.reset}`;
    drawFooter();

    (async () => {
      try {
        const status = await execAsync("git", ["status", "--porcelain"]);
        if (status.trim().length > 0) {
          statusMsg = `${ANSI.red}Working directory not clean — commit or stash changes first${ANSI.reset}`;
          busy = false;
          drawFooter();
          return;
        }

        statusMsg = `${ANSI.amber}Checking out ${pr.headRefName}…${ANSI.reset}`;
        drawFooter();

        await execAsync("git", ["fetch", "origin",
          `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`]);

        let localExists = false;
        try {
          await execAsync("git", ["rev-parse", "--verify", `refs/heads/${pr.headRefName}`]);
          localExists = true;
        } catch {}

        if (localExists) {
          await execAsync("git", ["switch", pr.headRefName]);
        } else {
          await execAsync("git", ["checkout", "-b", pr.headRefName, `origin/${pr.headRefName}`]);
        }
        statusMsg = `${ANSI.green}Checked out ${pr.headRefName}${ANSI.reset}`;
      } catch (e: unknown) {
        const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
        const columns = process.stdout.columns || 80;
        statusMsg = `${ANSI.red}Checkout failed: ${msg.slice(0, columns - 20)}${ANSI.reset}`;
      } finally {
        busy = false;
        drawFooter();
      }
    })();
  }

  const templateLabels = Array.from(templatesMap.keys());

  function drawCommentInput(): void {
    const termRows = process.stdout.rows || 24;
    const termCols = process.stdout.columns || 80;
    const footerLine = termRows - 1;
    const target = commentTarget;
    if (!target) return;
    if (templatePickerMode && templateLabels.length > 0) {
      process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
      process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
      const templateList = templateLabels.map((l, i) => `[${i + 1}]${l}`).join(" ");
      process.stdout.write(`\x1b[${footerLine - 1};1H`);
      process.stdout.write(`${ANSI.bold}Select template: ${templateList} [c]ustom${ANSI.reset}`);
      process.stdout.write(`\x1b[${footerLine};1H`);
      process.stdout.write(`${ANSI.dim}Press 1-${templateLabels.length} to insert · c for custom${ANSI.reset}`);
      process.stdout.write("\x1b[?25h");
      return;
    }
    const isReply = target.kind === "comment";
    const targetExcerpt = isReply
      ? target.comment.body.replace(/\s+/g, " ").trim()
      : "";
    const targetLine = isReply
      ? `Reply target: #${target.pr.number} ${target.comment.path}:${target.comment.line ?? target.comment.original_line ?? "?"} · ${target.comment.user.login} · ${targetExcerpt}`
      : `Comment target: #${target.pr.number} ${target.pr.title}`;
    const inputPrefix = isReply ? "Reply: " : "Comment: ";
    const maxInputLen = Math.max(0, termCols - inputPrefix.length - 1);
    const visibleBuffer = truncatePlain(commentBuffer, maxInputLen);

    process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine - 1};1H`);
    process.stdout.write(`${ANSI.bold}${truncatePlain(targetLine, termCols)}${ANSI.reset}`);
    process.stdout.write(`\x1b[${footerLine};1H`);
    process.stdout.write(`${ANSI.bold}${inputPrefix}${ANSI.reset}${visibleBuffer}`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    process.stdout.write(`${ANSI.dim}Enter to send · Esc to cancel${ANSI.reset}`);
    process.stdout.write("\x1b[?25h");
    process.stdout.write(`\x1b[${footerLine};${Math.min(termCols, inputPrefix.length + visibleBuffer.length + 1)}H`);
  }

  function startCommentInput(): void {
    if (busy || virtualRows.length === 0) return;
    const vr = virtualRows[selectedIndex];
    if (!vr) return;
    const pr = currentPRs[vr.prIndex];
    if (!pr) return;

    commentInputMode = true;
    templatePickerMode = templateLabels.length > 0;
    if (vr.kind === "comment" || vr.kind === "comment-body") {
      const comment = expandedComments[vr.commentIndex];
      if (!comment) return;
      commentTarget = { kind: "comment", pr, comment };
    } else {
      commentTarget = { kind: "pr", pr };
    }
    commentBuffer = pr.agent ? `@${pr.agent} ` : "";
    drawCommentInput();
  }

  function handleCommentKey(key: string): void {
    if (key === "\x1b" || key === "\x03") {
      commentInputMode = false;
      templatePickerMode = false;
      commentTarget = null;
      commentBuffer = "";
      process.stdout.write("\x1b[?25l");
      drawFooter();
      return;
    }

    if (key.startsWith("\x1b")) return;

    if (templatePickerMode && templateLabels.length > 0) {
      const k = key.toLowerCase();
      if (k === "c") {
        templatePickerMode = false;
        drawCommentInput();
        return;
      }
      const num = parseInt(k, 10);
      if (num >= 1 && num <= templateLabels.length) {
        const body = templatesMap.get(templateLabels[num - 1]) ?? "";
        commentBuffer = (commentBuffer + body).trimStart();
        templatePickerMode = false;
        drawCommentInput();
        return;
      }
      return;
    }

    if (key === "\r") {
      const body = commentBuffer.trim();
      const target = commentTarget;
      commentInputMode = false;
      commentTarget = null;
      commentBuffer = "";
      process.stdout.write("\x1b[?25l");

      if (!target) {
        statusMsg = `${ANSI.red}No comment target selected${ANSI.reset}`;
        drawFooter();
        return;
      }

      if (body.length === 0) {
        statusMsg = `${ANSI.dim}Empty comment, cancelled${ANSI.reset}`;
        commentInputMode = false;
        templatePickerMode = false;
        commentTarget = null;
        commentBuffer = "";
        process.stdout.write("\x1b[?25l");
        drawFooter();
        return;
      }

      commentInputMode = false;
      templatePickerMode = false;
      commentTarget = null;
      commentBuffer = "";

      statusMsg = target.kind === "comment"
        ? `${ANSI.amber}Posting reply on #${target.pr.number}…${ANSI.reset}`
        : `${ANSI.amber}Posting comment on #${target.pr.number}…${ANSI.reset}`;
      process.stdout.write("\x1b[?25l");
      drawFooter();

      (async () => {
        try {
          if (target.kind === "comment") {
            const result = await postPullRequestReply({
              repo: target.pr.repo,
              prNumber: target.pr.number,
              inReplyToId: target.comment.id,
              body,
              cursorApiKey,
            });
            statusMsg = result.mode === "cursor-followup"
              ? `${ANSI.green}Reply sent via Cursor API on #${target.pr.number}${ANSI.reset}`
              : result.mode === "cursor-launch"
                ? `${ANSI.green}No linked agent; launched Cursor agent for #${target.pr.number}${ANSI.reset}`
                : `${ANSI.green}Reply posted on #${target.pr.number}${ANSI.reset}`;
          } else {
            await postPullRequestComment(target.pr.repo, target.pr.number, body);
            statusMsg = `${ANSI.green}Comment posted on #${target.pr.number}${ANSI.reset}`;
          }
        } catch {
          statusMsg = target.kind === "comment"
            ? `${ANSI.red}Failed to post reply on #${target.pr.number}${ANSI.reset}`
            : `${ANSI.red}Failed to post comment on #${target.pr.number}${ANSI.reset}`;
        }
        drawFooter();
      })();
      return;
    }

    if (key === "\x7f" || key === "\b") {
      if (commentBuffer.length > 0) {
        commentBuffer = commentBuffer.slice(0, -1);
      }
      drawCommentInput();
      return;
    }

    if (key === "\x15") {
      commentBuffer = "";
      drawCommentInput();
      return;
    }

    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      commentBuffer += key;
      drawCommentInput();
    }
  }

  function applySearchFilter(): void {
    expandedPRIndex = null;
    expandedPRNumber = null;
    expandedComments = [];
    expandedFiles = [];
    expandedLoading = false;
    expandedMode = "comments";
    const oldLen = virtualRows.length;
    rebuildVirtualRows();
    clampSelection();
    drawAllRows();
    clearStaleRows(oldLen);
    drawTitle();
    if (searchMode) {
      drawSearchInput();
    } else {
      drawFooter();
    }
  }

  function drawSearchInput(): void {
    const termRows = process.stdout.rows || 24;
    const footerLine = termRows - 1;
    process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(`${ANSI.bold}/${ANSI.reset}${searchBuffer}`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    process.stdout.write(`${ANSI.dim}Enter to apply · Esc to cancel${ANSI.reset}`);
    process.stdout.write("\x1b[?25h");
    process.stdout.write(`\x1b[${footerLine};${2 + searchBuffer.length}H`);
  }

  function startSearchMode(): void {
    preSearchQuery = searchQuery;
    searchBuffer = searchQuery;
    searchMode = true;
    drawSearchInput();
  }

  function drawIssueCreateInput(): void {
    const termRows = process.stdout.rows || 24;
    const termCols = process.stdout.columns || 80;
    const footerLine = termRows - 1;

    process.stdout.write(`\x1b[${footerLine - 2};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);

    if (issueCreateStep === "title") {
      const repo = issueTargetRepo || "?";
      process.stdout.write(`\x1b[${footerLine - 2};1H`);
      process.stdout.write(`${ANSI.bold}Create issue in ${repo}${ANSI.reset}`);
      process.stdout.write(`\x1b[${footerLine - 1};1H`);
      process.stdout.write(`${ANSI.bold}Title: ${ANSI.reset}${issueTitleBuffer}`);
      process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
      process.stdout.write(`${ANSI.dim}Enter to continue · Esc to cancel${ANSI.reset}`);
      process.stdout.write("\x1b[?25h");
      process.stdout.write(`\x1b[${footerLine - 1};${8 + issueTitleBuffer.length}H`);
    } else if (issueCreateStep === "body") {
      process.stdout.write(`\x1b[${footerLine - 2};1H`);
      process.stdout.write(`${ANSI.dim}Title: ${issueTitleBuffer}${ANSI.reset}`);
      process.stdout.write(`\x1b[${footerLine - 1};1H`);
      process.stdout.write(`${ANSI.bold}Body: ${ANSI.reset}${issueBodyBuffer}`);
      process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
      process.stdout.write(`${ANSI.dim}Enter to continue (or skip) · Esc to cancel${ANSI.reset}`);
      process.stdout.write("\x1b[?25h");
      process.stdout.write(`\x1b[${footerLine - 1};${7 + issueBodyBuffer.length}H`);
    } else if (issueCreateStep === "template") {
      process.stdout.write(`\x1b[${footerLine - 2};1H`);
      process.stdout.write(`${ANSI.bold}Select agent comment:${ANSI.reset} [0] None  [1] Research  [2] Plan  [3] Fix`);
      process.stdout.write(`\x1b[${footerLine - 1};1H`);
      process.stdout.write(`${ANSI.bold}Choice (0-3): ${ANSI.reset}${issueTemplateChoice >= 0 ? String(issueTemplateChoice) : ""}`);
      process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
      process.stdout.write(`${ANSI.dim}Enter to create · Esc to cancel${ANSI.reset}`);
      process.stdout.write("\x1b[?25h");
      process.stdout.write(`\x1b[${footerLine - 1};${15 + (issueTemplateChoice >= 0 ? 1 : 0)}H`);
    }
  }

  function startIssueCreate(): void {
    if (busy) return;

    let targetRepo: string;
    
    if (singleRepo) {
      targetRepo = repos[0];
    } else {
      const pr = selectedPR();
      if (!pr) {
        statusMsg = `${ANSI.red}No PR selected (select a PR to use its repo for the issue)${ANSI.reset}`;
        drawFooter();
        return;
      }
      targetRepo = pr.repo;
    }

    issueCreateMode = true;
    issueCreateStep = "title";
    issueTitleBuffer = "";
    issueBodyBuffer = "";
    issueTemplateChoice = -1;
    issueTargetRepo = targetRepo;
    drawIssueCreateInput();
  }

  function handleIssueCreateKey(key: string): void {
    if (key === "\x1b" || key === "\x03") {
      issueCreateMode = false;
      issueCreateStep = "title";
      issueTitleBuffer = "";
      issueBodyBuffer = "";
      issueTemplateChoice = -1;
      issueTargetRepo = null;
      process.stdout.write("\x1b[?25l");
      drawFooter();
      return;
    }

    if (key.startsWith("\x1b")) return;

    if (issueCreateStep === "title") {
      if (key === "\r") {
        const title = issueTitleBuffer.trim();
        if (title.length === 0) {
          statusMsg = `${ANSI.red}Title cannot be empty${ANSI.reset}`;
          issueCreateMode = false;
          issueCreateStep = "title";
          issueTitleBuffer = "";
          issueBodyBuffer = "";
          issueTargetRepo = null;
          process.stdout.write("\x1b[?25l");
          drawFooter();
          return;
        }
        issueCreateStep = "body";
        drawIssueCreateInput();
        return;
      }

      if (key === "\x7f" || key === "\b") {
        if (issueTitleBuffer.length > 0) {
          issueTitleBuffer = issueTitleBuffer.slice(0, -1);
        }
        drawIssueCreateInput();
        return;
      }

      if (key === "\x15") {
        issueTitleBuffer = "";
        drawIssueCreateInput();
        return;
      }

      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        issueTitleBuffer += key;
        drawIssueCreateInput();
      }
    } else if (issueCreateStep === "body") {
      if (key === "\r") {
        issueCreateStep = "template";
        drawIssueCreateInput();
        return;
      }

      if (key === "\x7f" || key === "\b") {
        if (issueBodyBuffer.length > 0) {
          issueBodyBuffer = issueBodyBuffer.slice(0, -1);
        }
        drawIssueCreateInput();
        return;
      }

      if (key === "\x15") {
        issueBodyBuffer = "";
        drawIssueCreateInput();
        return;
      }

      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        issueBodyBuffer += key;
        drawIssueCreateInput();
      }
    } else if (issueCreateStep === "template") {
      if (key === "\r") {
        const choice = issueTemplateChoice;
        const title = issueTitleBuffer.trim();
        const body = issueBodyBuffer.trim();
        const repo = issueTargetRepo;

        issueCreateMode = false;
        issueCreateStep = "title";
        issueTitleBuffer = "";
        issueBodyBuffer = "";
        issueTemplateChoice = -1;
        issueTargetRepo = null;
        process.stdout.write("\x1b[?25l");

        if (!repo || !title) {
          statusMsg = `${ANSI.red}Missing repo or title${ANSI.reset}`;
          drawFooter();
          return;
        }

        if (choice < 0 || choice > 3) {
          statusMsg = `${ANSI.red}Invalid template choice${ANSI.reset}`;
          drawFooter();
          return;
        }

        statusMsg = `${ANSI.amber}Creating issue in ${repo}…${ANSI.reset}`;
        drawFooter();

        (async () => {
          try {
            const pr = selectedPR();
            const agent = pr?.agent || "cursor";
            const result = await createIssueWithAgentComment({
              repo,
              title,
              body,
              agent,
              templateChoice: choice as 0 | 1 | 2 | 3,
            });
            statusMsg = result.commentAdded
              ? `${ANSI.green}Created issue #${result.issueNumber} with comment${ANSI.reset}`
              : `${ANSI.green}Created issue #${result.issueNumber}${ANSI.reset}`;
          } catch (e: unknown) {
            const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
            statusMsg = `${ANSI.red}Failed to create issue: ${msg.slice(0, 50)}${ANSI.reset}`;
          }
          drawFooter();
        })();
        return;
      }

      if (key >= "0" && key <= "3") {
        issueTemplateChoice = parseInt(key, 10);
        drawIssueCreateInput();
      }
    }
  }

  function handleSearchKey(key: string): void {
    if (key === "\x1b" || key === "\x03") {
      searchMode = false;
      searchQuery = preSearchQuery;
      searchBuffer = "";
      process.stdout.write("\x1b[?25l");
      applySearchFilter();
      return;
    }

    if (key.startsWith("\x1b")) return;

    if (key === "\r") {
      searchMode = false;
      searchQuery = searchBuffer;
      searchBuffer = "";
      process.stdout.write("\x1b[?25l");
      applySearchFilter();
      return;
    }

    if (key === "\x7f" || key === "\b") {
      if (searchBuffer.length > 0) {
        searchBuffer = searchBuffer.slice(0, -1);
      }
      searchQuery = searchBuffer;
      applySearchFilter();
      return;
    }

    if (key === "\x15") {
      searchBuffer = "";
      searchQuery = searchBuffer;
      applySearchFilter();
      return;
    }

    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      searchBuffer += key;
      searchQuery = searchBuffer;
      applySearchFilter();
    }
  }

  function drawTitle(): void {
    process.stdout.write("\x1b[1;1H\x1b[2K");
    let title = `${TITLE}  ${ANSI.dim}[${mineOnlyFilter ? "mine" : "all authors"}] [f] mine/all [/] filter:` +
      `${searchQuery ? ` ${searchQuery}` : ""}${ANSI.reset}`;
    const vh = getViewportHeight();
    if (virtualRows.length > vh) {
      title += `  ${ANSI.dim}[${scrollOffset + 1}\u2013${Math.min(scrollOffset + vh, virtualRows.length)} of ${virtualRows.length}]${ANSI.reset}`;
    }
    process.stdout.write(title);
  }

  function drawFooter(): void {
    const termRows = process.stdout.rows || 24;
    const footerLine = termRows - 1;
    process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(
      `${ANSI.dim}↑↓ select  ⏎ expand  [d]iff  [o]pen  [c]heckout  [C]omment/reply  [i]ssue  [r]erun  [u]pdate  [a]pprove  [m]erge  │  ` +
      `[R] all  [U] all  [q]uit${ANSI.reset}`
    );
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    if (statusMsg) process.stdout.write(statusMsg);
  }

  function clampSelection(): void {
    if (virtualRows.length === 0) {
      selectedIndex = 0;
      scrollOffset = 0;
    } else {
      selectedIndex = Math.min(selectedIndex, virtualRows.length - 1);
    }
    ensureVisible();
  }

  function refresh(): void {
    ciGeneration++;
    const gen = ciGeneration;
    ciUpdatePending = true;

    (async () => {
      try {
        const sortedPrs = await fetchPRsWithStatus({ repos, mineOnly: mineOnlyFilter });
        if (gen !== ciGeneration || isInterrupted()) return;
        const oldVirtualLen = virtualRows.length;
        currentPRs = sortedPrs;

        if (expandedPRNumber !== null) {
          const newIdx = currentPRs.findIndex(p => p.number === expandedPRNumber);
          if (newIdx === -1) {
            expandedPRIndex = null;
            expandedPRNumber = null;
            expandedComments = [];
            expandedFiles = [];
            expandedMode = "comments";
          } else {
            expandedPRIndex = newIdx;
          }
        }

        rebuildVirtualRows();
        clampSelection();
        drawAllRows();
        clearStaleRows(oldVirtualLen);

        if (sortedPrs.length === 0) {
          process.stdout.write(`\x1b[${ROW_START};1H\x1b[2K`);
          process.stdout.write("No agent PRs found.");
        }
        drawFooter();
      } catch (e: unknown) {
        if (isInterrupted()) return;
        const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
        const columns = process.stdout.columns || 80;
        const maxLen = columns - 25;
        const truncMsg = msg.length > maxLen ? msg.slice(0, maxLen - 1) + "…" : msg;
        statusMsg = `${ANSI.amber}API error, will retry: ${truncMsg}${ANSI.reset}`;
        drawFooter();
      } finally {
        if (gen === ciGeneration) ciUpdatePending = false;
        if (isInterrupted()) cleanup();
      }
    })();
  }

  function moveSelection(delta: number): void {
    if (virtualRows.length === 0) return;
    const prev = selectedIndex;
    selectedIndex = Math.max(0, Math.min(virtualRows.length - 1, selectedIndex + delta));
    if (prev !== selectedIndex) {
      const oldOffset = scrollOffset;
      ensureVisible();
      if (scrollOffset !== oldOffset) {
        drawAllRows();
        drawTitle();
      } else {
        drawRow(prev);
        drawRow(selectedIndex);
      }
    }
  }

  function toggleAuthorFilter(): void {
    if (busy) return;
    mineOnlyFilter = !mineOnlyFilter;
    statusMsg = mineOnlyFilter
      ? `${ANSI.dim}Showing only your PRs${ANSI.reset}`
      : `${ANSI.dim}Showing PRs from all authors${ANSI.reset}`;
    drawTitle();
    drawFooter();
    refresh();
  }

  function selectedPR(): PRWithStatus | null {
    const vr = virtualRows[selectedIndex];
    if (!vr) return null;
    return currentPRs[vr.prIndex] ?? null;
  }

  function handleOpenSelected(): void {
    const vr = virtualRows[selectedIndex];
    if (!vr) return;
    if (vr.kind === "comment" || vr.kind === "comment-body") {
      const comment = expandedComments[vr.commentIndex];
      if (!comment?.html_url) return;
      (async () => {
        try {
          const opener = process.platform === "darwin" ? "open" : "xdg-open";
          await execAsync(opener, [comment.html_url]);
          statusMsg = `${ANSI.green}Opened comment in browser${ANSI.reset}`;
        } catch {
          statusMsg = `${ANSI.red}Failed to open comment${ANSI.reset}`;
        }
        drawFooter();
      })();
      return;
    }
    const pr = selectedPR();
    if (!pr) return;
    (async () => {
      try {
        await ghQuietAsync("pr", "view", String(pr.number), "--repo", pr.repo, "--web");
        statusMsg = `${ANSI.green}Opened #${pr.number} in browser${ANSI.reset}`;
      } catch {
        statusMsg = `${ANSI.red}Failed to open #${pr.number}${ANSI.reset}`;
      }
      drawFooter();
    })();
  }

  function handleRerunSelected(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    if (pr.ciStatus !== "fail") {
      statusMsg = `${ANSI.dim}#${pr.number} has no failed CI to rerun${ANSI.reset}`;
      drawFooter();
      return;
    }

    pr.ciStatus = "pending";
    const vr = virtualRows[selectedIndex];
    if (vr) {
      const prVi = virtualRows.findIndex(v => v.kind === "pr" && v.prIndex === vr.prIndex);
      if (prVi !== -1) drawRow(prVi);
    }
    drawRow(selectedIndex);

    busy = true;
    statusMsg = `${ANSI.amber}Rerunning failed workflows for #${pr.number}…${ANSI.reset}`;
    drawFooter();

    (async () => {
      try {
        const { total } = await rerunFailedWorkflowRuns(pr.repo, pr.headRefName);
        statusMsg = total > 0
          ? `${ANSI.green}Reran ${total} workflow(s) for #${pr.number}${ANSI.reset}`
          : `${ANSI.dim}No failed workflows on #${pr.number}${ANSI.reset}`;
      } catch {
        statusMsg = `${ANSI.red}Failed to rerun workflows for #${pr.number}${ANSI.reset}`;
      } finally {
        if (isInterrupted()) { cleanup(); return; }
      }
      busy = false;
      drawFooter();
    })();
  }

  function handleUpdateSelected(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    busy = true;
    statusMsg = `${ANSI.amber}Merging main into #${pr.number}…${ANSI.reset}`;
    drawFooter();

    (async () => {
      try {
        const result = await mergeBaseIntoBranch(pr.repo, pr.headRefName, "main");
        if (result.alreadyUpToDate) {
          statusMsg = `${ANSI.dim}#${pr.number} already up to date with main${ANSI.reset}`;
        } else {
          statusMsg = `${ANSI.green}Merged main into #${pr.number}${ANSI.reset}`;
        }
      } catch {
        statusMsg = `${ANSI.red}Failed to merge main into #${pr.number}${ANSI.reset}`;
      } finally {
        if (isInterrupted()) { cleanup(); return; }
      }
      busy = false;
      drawFooter();
    })();
  }

  function handleApproveSelected(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    busy = true;
    statusMsg = `${ANSI.amber}Approving #${pr.number}…${ANSI.reset}`;
    drawFooter();

    (async () => {
      try {
        await approvePullRequest(pr.repo, pr.number);
        statusMsg = `${ANSI.green}Approved #${pr.number}${ANSI.reset}`;
      } catch (e: unknown) {
        const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").toLowerCase();
        if (msg.includes("already")) {
          statusMsg = `${ANSI.dim}#${pr.number} already approved${ANSI.reset}`;
        } else if (msg.includes("draft")) {
          statusMsg = `${ANSI.red}#${pr.number} is a draft — mark ready for review first${ANSI.reset}`;
        } else {
          statusMsg = `${ANSI.red}Failed to approve #${pr.number}${ANSI.reset}`;
        }
      } finally {
        if (isInterrupted()) { cleanup(); return; }
      }
      busy = false;
      drawFooter();
    })();
  }

  function handleMergeWhenReady(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    busy = true;
    statusMsg = `${ANSI.amber}Enabling merge when ready for #${pr.number}…${ANSI.reset}`;
    drawFooter();

    (async () => {
      try {
        await enableMergeWhenReady(pr.repo, pr.number);
        statusMsg = `${ANSI.green}Merge when ready enabled for #${pr.number}${ANSI.reset}`;
      } catch (e: unknown) {
        const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").toLowerCase();
        if (msg.includes("already") && (msg.includes("auto") || msg.includes("queued"))) {
          statusMsg = `${ANSI.dim}#${pr.number} already has merge when ready enabled${ANSI.reset}`;
        } else if (msg.includes("draft")) {
          statusMsg = `${ANSI.red}#${pr.number} is a draft — mark ready for review first${ANSI.reset}`;
        } else {
          statusMsg = `${ANSI.red}Failed to enable merge when ready for #${pr.number}${ANSI.reset}`;
        }
      } finally {
        if (isInterrupted()) { cleanup(); return; }
      }
      busy = false;
      drawFooter();
    })();
  }

  function handleRerunAllFailed(): void {
    if (busy || currentPRs.length === 0) return;

    const toRerun: PRWithStatus[] = [];
    let skipped = 0;
    for (const pr of currentPRs) {
      if (!matchesSearch(pr, searchQuery)) continue;
      if (pr.ciStatus !== "fail") continue;
      if (pr.stale) { skipped++; continue; }
      toRerun.push(pr);
    }

    if (toRerun.length === 0) {
      statusMsg = skipped > 0
        ? `${ANSI.dim}Skipped ${skipped} stale, no failed workflows to rerun${ANSI.reset}`
        : `${ANSI.dim}No failed workflows to rerun${ANSI.reset}`;
      drawFooter();
      return;
    }

    for (const pr of toRerun) pr.ciStatus = "pending";
    drawAllRows();

    busy = true;
    statusMsg = `${ANSI.amber}Rerunning all failed workflows…${ANSI.reset}`;
    drawFooter();

    (async () => {
      try {
        let total = 0;
        for (const pr of toRerun) {
          if (isInterrupted()) break;
          try {
            const result = await rerunFailedWorkflowRuns(pr.repo, pr.headRefName);
            total += result.total;
          } catch { /* skip PR */ }
        }

        const parts: string[] = [];
        if (total > 0) parts.push(`reran ${total} workflow(s)`);
        if (skipped > 0) parts.push(`skipped ${skipped} stale`);
        statusMsg = total > 0
          ? `${ANSI.green}${parts.join(", ")}${ANSI.reset}`
          : `${ANSI.dim}${parts.length > 0 ? parts.join(", ") : "no failed workflows to rerun"}${ANSI.reset}`;
      } finally {
        if (isInterrupted()) { cleanup(); return; }
      }
      busy = false;
      drawFooter();
      await new Promise(r => setTimeout(r, BULK_COOLDOWN_MS));
      refresh();
    })();
  }

  function handleUpdateAllMain(): void {
    if (busy || currentPRs.length === 0) return;
    busy = true;
    statusMsg = `${ANSI.amber}Merging main into all PR branches…${ANSI.reset}`;
    drawFooter();

    (async () => {
      try {
        let updated = 0;
        let upToDate = 0;
        for (const pr of currentPRs) {
          if (!matchesSearch(pr, searchQuery)) continue;
          if (isInterrupted()) break;
          try {
            const result = await mergeBaseIntoBranch(pr.repo, pr.headRefName, "main");
            if (result.alreadyUpToDate) {
              upToDate++;
            } else {
              updated++;
            }
          } catch {
            // Skip failures in bulk mode.
          }
        }
        statusMsg = `${ANSI.green}Updated ${updated}, ${upToDate} already up to date${ANSI.reset}`;
      } finally {
        if (isInterrupted()) { cleanup(); return; }
      }
      busy = false;
      drawFooter();
      await new Promise(r => setTimeout(r, BULK_COOLDOWN_MS));
      refresh();
    })();
  }

  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
  drawTitle();
  process.stdout.write("\n\n");
  console.log(buildTableHeader(singleRepo));
  console.log(tableSeparator());
  process.stdout.write(`\x1b[${ROW_START};1H${ANSI.dim}Loading…${ANSI.reset}`);
  drawFooter();

  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    process.stdin.on("data", (key: string) => {
      if (commentInputMode) {
        handleCommentKey(key);
        return;
      }

      if (searchMode) {
        handleSearchKey(key);
        return;
      }

      if (issueCreateMode) {
        handleIssueCreateKey(key);
        return;
      }

      if (key === "q" || key === "\x03") cleanup();

      if (key === "\x1b[A" || key === "k") { moveSelection(-1); return; }
      if (key === "\x1b[B" || key === "j") { moveSelection(1); return; }
      if (key === "\x1b[5~") { moveSelection(-getViewportHeight()); return; }
      if (key === "\x1b[6~") { moveSelection(getViewportHeight()); return; }

      if (busy) return;

      if (key === "\r") { handleToggleExpand(); return; }
      if (key === "d") { handleToggleDiff(); return; }
      if (key === "o") { handleOpenSelected(); return; }
      if (key === "c") { handleCheckout(); return; }
      if (key === "C") { startCommentInput(); return; }
      if (key === "i") { startIssueCreate(); return; }
      if (key === "r") { handleRerunSelected(); return; }
      if (key === "u") { handleUpdateSelected(); return; }
      if (key === "a") { handleApproveSelected(); return; }
      if (key === "m") { handleMergeWhenReady(); return; }

      if (key === "/") { startSearchMode(); return; }
      if (key === "f") { toggleAuthorFilter(); return; }

      if (key === "R") handleRerunAllFailed();
      if (key === "U") handleUpdateAllMain();
    });
  }

  refresh();

  function loop(): void {
    if (isInterrupted()) { cleanup(); return; }
    if (!busy && !ciUpdatePending) refresh();
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
  ↑↓/jk navigate  ⏎ expand  [d]iff  [/]filter  [f]mine/all  [o]pen  [c]heckout  [C]omment/reply  [i]ssue
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
