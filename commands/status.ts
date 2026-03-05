/**
 * Unified dashboard: full picture of agent PRs across all configured repos.
 * Usage: copse status [options]
 *        Defaults to live TUI mode; use --no-watch for one-shot output.
 */

import { execFile as execFileCb } from "child_process";
import {
  listOpenPRs,
  listOpenPRsAsync,
  listWorkflowRuns,
  listWorkflowRunsAsync,
  getAgentForPR,
  validateRepo,
  REPO_PATTERN,
  gh,
  ghQuietAsync,
  getUnresolvedCommentCounts,
  getUnresolvedCommentCountsAsync,
  listPRReviewCommentsAsync,
  addPRCommentAsync,
  replyToPRCommentAsync,
  isInterrupted,
  setPipeStdio,
} from "../lib/gh.js";
import type { WorkflowRun, PRReviewComment } from "../lib/types.js";
import { filterPRs, getUserForDisplay, buildFetchMessage } from "../lib/filters.js";
import { getConfiguredRepos } from "../lib/config.js";
import { getOriginRepo } from "../lib/utils.js";
import { parseStandardFlags } from "../lib/args.js";

function execAsync(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(command, args, { encoding: "utf-8", timeout: 30_000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout);
    });
  });
}

const STATUS_FIELDS = [
  "number", "headRefName", "labels", "title", "author",
  "mergeStateStatus", "mergeable", "reviewDecision", "createdAt", "updatedAt",
  "autoMergeRequest",
];

const STALE_DAYS = 7;
const WATCH_INTERVAL_MS = 30_000;
const BULK_COOLDOWN_MS = 2_000;

export interface PRWithStatus {
  repo: string;
  number: number;
  headRefName: string;
  title: string;
  author: { login: string };
  mergeStateStatus: string;
  mergeable: string;
  reviewDecision: string;
  updatedAt: string;
  agent: string | null;
  autoMerge: boolean;
  ciStatus: "pass" | "fail" | "pending" | "none";
  conflicts: boolean;
  ageDays: number;
  stale: boolean;
  readyToMerge: boolean;
  commentCount: number;
}

export type Urgency = "red" | "amber" | "green";

function getUrgency(pr: PRWithStatus): Urgency {
  if (pr.ciStatus === "fail" || pr.conflicts) return "red";
  if (pr.stale || pr.reviewDecision === "CHANGES_REQUESTED" || pr.ciStatus === "pending") return "amber";
  return "green";
}

function sortPRs(prs: PRWithStatus[]): PRWithStatus[] {
  return prs.sort((a, b) => a.ageDays - b.ageDays);
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

function fetchPRsBase(repos: string[], mineOnly: boolean): PRWithStatus[] {
  const result: PRWithStatus[] = [];
  const now = Date.now();

  for (const repo of repos) {
    validateRepo(repo);
    const rawPRs = listOpenPRs(repo, STATUS_FIELDS);
    const matching = filterPRs(rawPRs, { repo, agent: null, mineOnly });

    for (const pr of matching) {
      const mergeStateStatus = (pr as { mergeStateStatus?: string }).mergeStateStatus ?? "";
      const reviewDecision = (pr as { reviewDecision?: string }).reviewDecision ?? "REVIEW_REQUIRED";
      const createdAt = (pr as { createdAt?: string }).createdAt ?? "";
      const updatedAt = (pr as { updatedAt?: string }).updatedAt ?? "";
      const ageDays = createdAt
        ? Math.floor((now - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      result.push({
        repo,
        number: pr.number,
        headRefName: pr.headRefName,
        title: pr.title ?? "",
        author: pr.author,
        mergeStateStatus,
        mergeable: (pr as { mergeable?: string }).mergeable ?? "UNKNOWN",
        reviewDecision,
        updatedAt,
        agent: getAgentForPR(pr),
        autoMerge: (pr as { autoMergeRequest?: unknown }).autoMergeRequest != null,
        ciStatus: "pending",
        conflicts: mergeStateStatus === "HAS_CONFLICTS",
        ageDays,
        stale: ageDays >= STALE_DAYS,
        readyToMerge: false,
        commentCount: 0,
      });
    }
  }

  return sortPRs(result);
}

function applyCIStatus(pr: PRWithStatus, runs: WorkflowRun[]): void {
  const failed = runs.filter((r) => r.conclusion === "failure");
  const inProgress = runs.filter(
    (r) => r.status === "in_progress" || r.status === "queued" || r.status === "requested"
  );

  if (failed.length > 0) pr.ciStatus = "fail";
  else if (inProgress.length > 0) pr.ciStatus = "pending";
  else if (runs.some((r) => r.conclusion === "success")) pr.ciStatus = "pass";
  else pr.ciStatus = "none";

  pr.readyToMerge =
    pr.ciStatus === "pass" &&
    !pr.conflicts &&
    (pr.reviewDecision === "APPROVED" || pr.reviewDecision === null);
}

function updateCommentCounts(prs: PRWithStatus[]): void {
  const byRepo = new Map<string, PRWithStatus[]>();
  for (const pr of prs) {
    const list = byRepo.get(pr.repo) ?? [];
    list.push(pr);
    byRepo.set(pr.repo, list);
  }
  for (const [repo, repoPrs] of byRepo) {
    try {
      const counts = getUnresolvedCommentCounts(repo, repoPrs.map(p => p.number));
      for (const pr of repoPrs) {
        pr.commentCount = counts.get(pr.number) ?? 0;
      }
    } catch { /* leave as 0 */ }
  }
}

function updateAllCIStatuses(prs: PRWithStatus[]): void {
  const branchCache = new Map<string, WorkflowRun[]>();
  for (const pr of prs) {
    const key = `${pr.repo}\0${pr.headRefName}`;
    let runs = branchCache.get(key);
    if (runs === undefined) {
      try { runs = listWorkflowRuns(pr.repo, pr.headRefName); }
      catch { runs = []; }
      branchCache.set(key, runs);
    }
    applyCIStatus(pr, runs);
  }
}

function fetchPRsWithStatus(repos: string[], mineOnly: boolean): PRWithStatus[] {
  const prs = fetchPRsBase(repos, mineOnly);
  updateCommentCounts(prs);
  updateAllCIStatuses(prs);
  return sortPRs(prs);
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
  const prs = fetchPRsWithStatus(repos, mineOnly);
  renderTable(prs, repos.length === 1);
}

function runWatch(repos: string[], mineOnly: boolean): void {
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
    | { kind: "info"; prIndex: number; text: string };

  let virtualRows: VirtualRow[] = [];
  let expandedPRIndex: number | null = null;
  let expandedPRNumber: number | null = null;
  let expandedComments: PRReviewComment[] = [];
  let expandedLoading = false;
  const DETAIL_MAX_LINES = 10;

  let commentInputMode = false;
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
    ensureVisible();
    process.stdout.write("\x1b[2J\x1b[H");
    drawTitle();
    process.stdout.write(`\x1b[3;1H${buildTableHeader(singleRepo)}`);
    process.stdout.write(`\x1b[4;1H${tableSeparator()}`);
    drawAllRows();
    if (commentInputMode) drawCommentInput();
    else if (searchMode) drawSearchInput();
    else drawFooter();
  });

  function rebuildVirtualRows(): void {
    virtualRows = [];
    for (let i = 0; i < currentPRs.length; i++) {
      if (!matchesSearch(currentPRs[i], searchQuery)) continue;
      virtualRows.push({ kind: "pr", prIndex: i });
      if (expandedPRIndex === i) {
        if (expandedLoading) {
          virtualRows.push({ kind: "info", prIndex: i,
            text: `  ${ANSI.dim}Loading comments for #${currentPRs[i].number}…${ANSI.reset}` });
        } else if (expandedComments.length === 0) {
          virtualRows.push({ kind: "info", prIndex: i,
            text: `  ${ANSI.dim}No unresolved comments on #${currentPRs[i].number}${ANSI.reset}` });
        } else {
          const maxVisible = Math.min(expandedComments.length, DETAIL_MAX_LINES);
          for (let j = 0; j < maxVisible; j++) {
            virtualRows.push({ kind: "comment", prIndex: i, commentIndex: j });
          }
          if (expandedComments.length > maxVisible) {
            virtualRows.push({ kind: "info", prIndex: i,
              text: `    ${ANSI.dim}${expandedComments.length - maxVisible} more — press [o] to view on GitHub${ANSI.reset}` });
          }
        }
      }
    }
  }

  function formatCommentRow(comment: PRReviewComment): string {
    const columns = process.stdout.columns || 80;
    const loc = String(comment.line ?? comment.original_line ?? "?");
    const pathLoc = `${comment.path}:${loc}`;
    const pathLocMax = Math.max(12, Math.floor(columns * 0.36));
    const pathLocTrunc = truncatePlain(pathLoc, pathLocMax);
    const bodyRaw = comment.body
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const prefix = `    ${comment.user.login} · ${pathLocTrunc} · `;
    const maxBodyLen = Math.max(10, columns - visibleLength(prefix) - 1);
    const truncBody = truncatePlain(bodyRaw, maxBodyLen);
    return `${prefix}${ANSI.dim}${truncBody}${ANSI.reset}`;
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
    expandedLoading = false;
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
    expandedLoading = true;
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

  function drawCommentInput(): void {
    const termRows = process.stdout.rows || 24;
    const termCols = process.stdout.columns || 80;
    const footerLine = termRows - 1;
    const target = commentTarget;
    if (!target) return;
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
    if (vr.kind === "comment") {
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
      commentTarget = null;
      commentBuffer = "";
      process.stdout.write("\x1b[?25l");
      drawFooter();
      return;
    }

    if (key.startsWith("\x1b")) return;

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
        drawFooter();
        return;
      }

      statusMsg = target.kind === "comment"
        ? `${ANSI.amber}Posting reply on #${target.pr.number}…${ANSI.reset}`
        : `${ANSI.amber}Posting comment on #${target.pr.number}…${ANSI.reset}`;
      drawFooter();

      (async () => {
        try {
          if (target.kind === "comment") {
            await replyToPRCommentAsync(target.pr.repo, target.pr.number, target.comment.id, body);
            statusMsg = `${ANSI.green}Reply posted on #${target.pr.number}${ANSI.reset}`;
          } else {
            await addPRCommentAsync(target.pr.repo, target.pr.number, body);
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
    expandedLoading = false;
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
      `${ANSI.dim}↑↓ select  ⏎ expand  [g]refresh  [o]pen  [c]heckout  [C]omment/reply  [r]erun  [u]pdate  [a]pprove  [m]erge  │  ` +
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
        const prs: PRWithStatus[] = [];
        const now = Date.now();
        const oldByKey = new Map(currentPRs.map(p => [`${p.repo}#${p.number}`, p]));
        for (const repo of repos) {
          validateRepo(repo);
          const rawPRs = await listOpenPRsAsync(repo, STATUS_FIELDS);
          if (gen !== ciGeneration || isInterrupted()) return;
          const matching = filterPRs(rawPRs, { repo, agent: null, mineOnly: mineOnlyFilter });

          for (const pr of matching) {
            const mergeStateStatus = (pr as { mergeStateStatus?: string }).mergeStateStatus ?? "";
            const reviewDecision = (pr as { reviewDecision?: string }).reviewDecision ?? "REVIEW_REQUIRED";
            const createdAt = (pr as { createdAt?: string }).createdAt ?? "";
            const updatedAt = (pr as { updatedAt?: string }).updatedAt ?? "";
            const ageDays = createdAt
              ? Math.floor((now - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000))
              : 0;

            const prev = oldByKey.get(`${repo}#${pr.number}`);
            prs.push({
              repo,
              number: pr.number,
              headRefName: pr.headRefName,
              title: pr.title ?? "",
              author: pr.author,
              mergeStateStatus,
              mergeable: (pr as { mergeable?: string }).mergeable ?? "UNKNOWN",
              reviewDecision,
              updatedAt,
              agent: getAgentForPR(pr),
              autoMerge: (pr as { autoMergeRequest?: unknown }).autoMergeRequest != null,
              ciStatus: prev?.ciStatus ?? "pending",
              conflicts: mergeStateStatus === "HAS_CONFLICTS",
              ageDays,
              stale: ageDays >= STALE_DAYS,
              readyToMerge: prev?.readyToMerge ?? false,
              commentCount: prev?.commentCount ?? 0,
            });
          }
        }

        const sortedPrs = sortPRs(prs);
        const oldVirtualLen = virtualRows.length;
        currentPRs = sortedPrs;

        if (expandedPRNumber !== null) {
          const newIdx = currentPRs.findIndex(p => p.number === expandedPRNumber);
          if (newIdx === -1) {
            expandedPRIndex = null;
            expandedPRNumber = null;
            expandedComments = [];
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

        if (sortedPrs.length === 0) return;

        // Comment counts phase
        if (gen !== ciGeneration || isInterrupted()) return;
        const byRepo = new Map<string, PRWithStatus[]>();
        for (const pr of currentPRs) {
          if (!matchesSearch(pr, searchQuery)) continue;
          const list = byRepo.get(pr.repo) ?? [];
          list.push(pr);
          byRepo.set(pr.repo, list);
        }
        for (const [repo, repoPrs] of byRepo) {
          if (gen !== ciGeneration || isInterrupted()) return;
          try {
            const counts = await getUnresolvedCommentCountsAsync(repo, repoPrs.map(p => p.number));
            for (const pr of repoPrs) {
              pr.commentCount = counts.get(pr.number) ?? 0;
            }
          } catch { /* leave as 0 */ }
        }
        if (gen !== ciGeneration || isInterrupted()) return;
        drawAllRows();
        drawFooter();

        // CI status phase — one fetch per unique branch
        const branchMap = new Map<string, { repo: string; branch: string; prIndices: number[] }>();
        for (let i = 0; i < currentPRs.length; i++) {
          const pr = currentPRs[i];
          if (!matchesSearch(pr, searchQuery)) continue;
          const key = `${pr.repo}\0${pr.headRefName}`;
          if (!branchMap.has(key)) {
            branchMap.set(key, { repo: pr.repo, branch: pr.headRefName, prIndices: [] });
          }
          branchMap.get(key)!.prIndices.push(i);
        }

        for (const { repo, branch, prIndices } of branchMap.values()) {
          if (gen !== ciGeneration || isInterrupted()) break;
          try {
            const runs = await listWorkflowRunsAsync(repo, branch);
            for (const i of prIndices) {
              applyCIStatus(currentPRs[i], runs);
              if (gen !== ciGeneration || isInterrupted()) break;
              const vi = virtualRows.findIndex(vr => vr.kind === "pr" && vr.prIndex === i);
              if (vi !== -1) drawRow(vi);
            }
          } catch { /* leave as pending */ }
        }
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
    if (vr.kind === "comment") {
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
        const runsJson = await ghQuietAsync(
          "run", "list",
          "--repo", pr.repo,
          "--branch", pr.headRefName,
          "--limit", "100",
          "--json", "databaseId,name,conclusion,attempt,status,displayTitle"
        );
        const runs = JSON.parse(runsJson || "[]") as WorkflowRun[];
        const failed = runs.filter(r => r.conclusion === "failure");
        let total = 0;
        for (const run of failed) {
          if (isInterrupted()) break;
          try {
            await ghQuietAsync("run", "rerun", String(run.databaseId), "--repo", pr.repo, "--failed");
            total++;
          } catch { /* skip */ }
        }
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
        await ghQuietAsync("api", `repos/${pr.repo}/merges`, "-f", `base=${pr.headRefName}`, "-f", "head=main");
        statusMsg = `${ANSI.green}Merged main into #${pr.number}${ANSI.reset}`;
      } catch (e: unknown) {
        const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").toLowerCase();
        if (msg.includes("nothing to merge") || msg.includes("already up to date")) {
          statusMsg = `${ANSI.dim}#${pr.number} already up to date with main${ANSI.reset}`;
        } else {
          statusMsg = `${ANSI.red}Failed to merge main into #${pr.number}${ANSI.reset}`;
        }
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
        await ghQuietAsync("pr", "review", "--repo", pr.repo, String(pr.number), "--approve");
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
        await ghQuietAsync("pr", "merge", "--repo", pr.repo, String(pr.number), "--auto");
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
            const runsJson = await ghQuietAsync(
              "run", "list",
              "--repo", pr.repo,
              "--branch", pr.headRefName,
              "--limit", "100",
              "--json", "databaseId,name,conclusion,attempt,status,displayTitle"
            );
            const runs = JSON.parse(runsJson || "[]") as WorkflowRun[];
            const failed = runs.filter(r => r.conclusion === "failure");
            for (const run of failed) {
              if (isInterrupted()) break;
              try {
                await ghQuietAsync("run", "rerun", String(run.databaseId), "--repo", pr.repo, "--failed");
                total++;
              } catch { /* skip */ }
            }
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
            await ghQuietAsync("api", `repos/${pr.repo}/merges`, "-f", `base=${pr.headRefName}`, "-f", "head=main");
            updated++;
          } catch (e: unknown) {
            const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").toLowerCase();
            if (msg.includes("nothing to merge") || msg.includes("already up to date")) {
              upToDate++;
            }
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

      if (key === "q" || key === "\x03") cleanup();

      if (key === "\x1b[A" || key === "k") { moveSelection(-1); return; }
      if (key === "\x1b[B" || key === "j") { moveSelection(1); return; }
      if (key === "\x1b[5~") { moveSelection(-getViewportHeight()); return; }
      if (key === "\x1b[6~") { moveSelection(getViewportHeight()); return; }

      if (busy) return;

      if (key === "\r") { handleToggleExpand(); return; }
      if (key === "o") { handleOpenSelected(); return; }
      if (key === "c") { handleCheckout(); return; }
      if (key === "C") { startCommentInput(); return; }
      if (key === "r") { handleRerunSelected(); return; }
      if (key === "u") { handleUpdateSelected(); return; }
      if (key === "a") { handleApproveSelected(); return; }
      if (key === "m") { handleMergeWhenReady(); return; }

      if (key === "g") { if (!ciUpdatePending) refresh(); return; }
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

function main(): void {
  const { flags, filtered } = parseStandardFlags(process.argv.slice(2));
  const { mineOnly } = flags;
  const noWatch = filtered.includes("--no-watch");
  const watch = !noWatch && !!process.stdout.isTTY;
  const filteredArgs = filtered.filter((a) => a !== "--watch" && a !== "--no-watch");

  const help = `Usage: status [options]

  Unified dashboard across all configured repos. Shows every open agent PR with
  CI status, review state, conflicts, age, comments, and merge-readiness.

  Uses origin remote when run inside a git repo (including submodules).
  Falls back to .copserc in cwd or parent: { "repos": ["owner/name", ...] }

  Defaults to live TUI mode when connected to a terminal.

Options:
  --no-watch  One-shot table output (no TUI)
  --mine      Only your PRs (default)
  --all       Include PRs from all authors

TUI keys:
  ↑↓/jk navigate  ⏎ expand  [g]refresh  [/]filter  [f]mine/all  [o]pen  [c]heckout
  [C]omment/reply  [r]erun  [u]pdate main  [a]pprove  [m]erge when ready
  [R]erun all  [U]pdate all  [q]uit
`;

  let repos: string[] = [];

  if (filteredArgs.length >= 1 && REPO_PATTERN.test(filteredArgs[0])) {
    repos = [filteredArgs[0]];
  } else {
    const origin = getOriginRepo();
    if (origin) {
      repos = [origin];
    } else {
      const configured = getConfiguredRepos();
      if (configured && configured.length > 0) {
        repos = configured;
      } else {
        console.error(help);
        console.error("\nNo repos configured. Add a .copserc with { \"repos\": [\"owner/name\"] } or run inside a git repo.");
        process.exit(1);
      }
    }
  }

  const currentUser = getUserForDisplay(mineOnly);
  const repoDesc = repos.length === 1 ? repos[0] : `${repos.length} repos`;
  console.error(buildFetchMessage(repoDesc, null, mineOnly, currentUser));
  console.error(`Scanning ${repos.length} repo(s)...\n`);

  if (watch) {
    runWatch(repos, mineOnly);
  } else {
    runOnce(repos, mineOnly);
  }
}

main();
