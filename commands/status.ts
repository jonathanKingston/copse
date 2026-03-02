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
      const updatedAt = (pr as { updatedAt?: string }).updatedAt ?? "";
      const ageDays = updatedAt
        ? Math.floor((now - new Date(updatedAt).getTime()) / (24 * 60 * 60 * 1000))
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

function updatePRCIStatus(pr: PRWithStatus): void {
  const runs = listWorkflowRuns(pr.repo, pr.headRefName);
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

function fetchPRsWithStatus(repos: string[], mineOnly: boolean): PRWithStatus[] {
  const prs = fetchPRsBase(repos, mineOnly);
  updateCommentCounts(prs);
  for (const pr of prs) {
    try { updatePRCIStatus(pr); } catch { /* leave as pending */ }
  }
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

function formatComments(pr: PRWithStatus): string {
  if (pr.commentCount === 0) return `${ANSI.dim}—${ANSI.reset}`;
  return `${ANSI.amber}${pr.commentCount}${ANSI.reset}`;
}

const FIXED_COLS_WIDTH = 35;
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
  const ageRaw = `${pr.ageDays}d`;
  const age = pr.ageDays >= STALE_DAYS ? `${ANSI.amber}${ageRaw}${ANSI.reset}` : ageRaw;
  const cmt = formatComments(pr);
  const titleShort = pr.title.slice(0, titleMaxWidth) + (pr.title.length > titleMaxWidth ? "…" : "");
  return `${color}${repoPart}${prNum} ${agent} ${ci}   ${rev}   ${con}   ${pad(age, 4)} ${pad(cmt, 3)} ${titleShort}${ANSI.reset}`;
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
    pad(headerLink("AGE", "days-since-last-update"), 5),
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
  const TITLE = `copse status — refresh every ${WATCH_INTERVAL_MS / 1000}s`;
  const ROW_START = 5;
  let prevRowCount = 0;
  let currentPRs: PRWithStatus[] = [];
  let statusMsg = "";
  let busy = false;
  let selectedIndex = 0;
  let ciGeneration = 0;
  let ciUpdatePending = false;
  const isTTY = !!process.stdin.isTTY;

  let expandedIndex: number | null = null;
  let expandedPRNumber: number | null = null;
  let detailComments: PRReviewComment[] = [];
  let detailLoading = false;
  let currentDetailHeight = 0;
  const DETAIL_MAX_LINES = 10;

  let commentInputMode = false;
  let commentBuffer = "";
  let commentPR: PRWithStatus | null = null;

  setPipeStdio(true);

  function cleanup(): void {
    if (isTTY) try { process.stdin.setRawMode(false); } catch {}
    process.stdout.write("\x1b[?25h\n");
    process.exit(0);
  }

  process.on("SIGINT", cleanup);

  function highlightRow(row: string): string {
    return `\x1b[7m${row.replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m")}\x1b[0m`;
  }

  function drawRow(index: number): void {
    if (index < 0 || index >= currentPRs.length) return;
    let row = formatPRRow(currentPRs[index], singleRepo);
    if (index === selectedIndex) row = highlightRow(row);
    process.stdout.write(`\x1b[${ROW_START + index};1H\x1b[2K${row}`);
  }

  function drawAllRows(): void {
    for (let i = 0; i < currentPRs.length; i++) drawRow(i);
  }

  function drawDetailSection(): void {
    if (expandedIndex === null || expandedIndex >= currentPRs.length) {
      currentDetailHeight = 0;
      return;
    }
    const columns = process.stdout.columns || 80;
    const pr = currentPRs[expandedIndex];
    const detailStart = ROW_START + currentPRs.length;

    process.stdout.write(`\x1b[${detailStart};1H\x1b[2K`);
    if (detailLoading) {
      process.stdout.write(`  ${ANSI.dim}Loading comments for #${pr.number}…${ANSI.reset}`);
      currentDetailHeight = 1;
      return;
    }

    if (detailComments.length === 0) {
      process.stdout.write(`  ${ANSI.dim}▼ No unresolved comments on #${pr.number}${ANSI.reset}`);
      currentDetailHeight = 1;
      return;
    }

    process.stdout.write(
      `  ${ANSI.bold}▼ ${detailComments.length} unresolved comment(s) on #${pr.number}${ANSI.reset}`
    );

    const maxVisible = Math.min(detailComments.length, DETAIL_MAX_LINES);
    for (let i = 0; i < maxVisible; i++) {
      const comment = detailComments[i];
      const line = detailStart + 1 + i;
      const loc = comment.line ?? comment.original_line ?? "?";
      const bodyRaw = comment.body
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const maxBodyLen = Math.max(20, columns - 50);
      const truncBody = bodyRaw.length > maxBodyLen ? bodyRaw.slice(0, maxBodyLen) + "…" : bodyRaw;
      process.stdout.write(
        `\x1b[${line};1H\x1b[2K` +
        `    ${ANSI.dim}${comment.user.login}${ANSI.reset} · ${comment.path}:${loc} · ${ANSI.dim}${truncBody}${ANSI.reset}`
      );
    }

    let totalLines = 1 + maxVisible;
    if (detailComments.length > maxVisible) {
      const moreLine = detailStart + 1 + maxVisible;
      process.stdout.write(
        `\x1b[${moreLine};1H\x1b[2K    ${ANSI.dim}${detailComments.length - maxVisible} more — press [o] to view on GitHub${ANSI.reset}`
      );
      totalLines++;
    }

    currentDetailHeight = totalLines;
  }

  function collapseDetail(): void {
    if (expandedIndex === null) return;
    const oldHeight = currentDetailHeight;
    expandedIndex = null;
    expandedPRNumber = null;
    detailComments = [];
    detailLoading = false;
    currentDetailHeight = 0;
    const detailStart = ROW_START + currentPRs.length;
    for (let i = 0; i < oldHeight; i++) {
      process.stdout.write(`\x1b[${detailStart + i};1H\x1b[2K`);
    }
    drawFooter(prevRowCount);
  }

  function handleToggleExpand(): void {
    if (currentPRs.length === 0) return;
    if (expandedIndex === selectedIndex) {
      collapseDetail();
      return;
    }

    const oldHeight = currentDetailHeight;
    expandedIndex = selectedIndex;
    expandedPRNumber = currentPRs[selectedIndex]?.number ?? null;
    detailComments = [];
    detailLoading = true;

    if (oldHeight > 0) {
      const detailStart = ROW_START + currentPRs.length;
      for (let i = 0; i < oldHeight; i++) {
        process.stdout.write(`\x1b[${detailStart + i};1H\x1b[2K`);
      }
    }
    currentDetailHeight = 0;
    drawDetailSection();
    drawFooter(prevRowCount);

    const pr = currentPRs[selectedIndex];
    if (!pr) return;

    (async () => {
      try {
        const comments = await listPRReviewCommentsAsync(pr.repo, pr.number);
        if (expandedPRNumber !== pr.number) return;
        detailComments = comments;
      } catch {
        detailComments = [];
      } finally {
        detailLoading = false;
      }
      if (expandedPRNumber === pr.number) {
        drawDetailSection();
        drawFooter(prevRowCount);
      }
    })();
  }

  function handleCheckout(): void {
    const pr = selectedPR();
    if (busy || !pr) return;

    const localRepo = getOriginRepo();
    if (!localRepo || localRepo !== pr.repo) {
      statusMsg = `${ANSI.red}Cannot checkout: not in the ${pr.repo} repository${ANSI.reset}`;
      drawFooter(prevRowCount);
      return;
    }

    busy = true;
    statusMsg = `${ANSI.amber}Checking git status…${ANSI.reset}`;
    drawFooter(prevRowCount);

    (async () => {
      try {
        const status = await execAsync("git", ["status", "--porcelain"]);
        if (status.trim().length > 0) {
          statusMsg = `${ANSI.red}Working directory not clean — commit or stash changes first${ANSI.reset}`;
          busy = false;
          drawFooter(prevRowCount);
          return;
        }

        statusMsg = `${ANSI.amber}Checking out ${pr.headRefName}…${ANSI.reset}`;
        drawFooter(prevRowCount);

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
        drawFooter(prevRowCount);
      }
    })();
  }

  function drawCommentInput(): void {
    const promptPrefix = `Comment on #${commentPR!.number}: `;
    const footerLine = ROW_START + Math.max(prevRowCount, 1) + currentDetailHeight + 1;
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(`${ANSI.bold}${promptPrefix}${ANSI.reset}${commentBuffer}`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    process.stdout.write(`${ANSI.dim}Enter to send · Esc to cancel${ANSI.reset}`);
    process.stdout.write(`\x1b[${footerLine + 2};1H\x1b[J`);
    process.stdout.write("\x1b[?25h");
    process.stdout.write(`\x1b[${footerLine};${promptPrefix.length + commentBuffer.length + 1}H`);
  }

  function startCommentInput(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    commentInputMode = true;
    commentPR = pr;
    commentBuffer = pr.agent ? `@${pr.agent} ` : "";
    drawCommentInput();
  }

  function handleCommentKey(key: string): void {
    if (key === "\x1b" || key === "\x03") {
      commentInputMode = false;
      commentPR = null;
      commentBuffer = "";
      process.stdout.write("\x1b[?25l");
      drawFooter(prevRowCount);
      return;
    }

    if (key.startsWith("\x1b")) return;

    if (key === "\r") {
      const body = commentBuffer.trim();
      const pr = commentPR!;
      commentInputMode = false;
      commentPR = null;
      commentBuffer = "";
      process.stdout.write("\x1b[?25l");

      if (body.length === 0) {
        statusMsg = `${ANSI.dim}Empty comment, cancelled${ANSI.reset}`;
        drawFooter(prevRowCount);
        return;
      }

      statusMsg = `${ANSI.amber}Posting comment on #${pr.number}…${ANSI.reset}`;
      drawFooter(prevRowCount);

      (async () => {
        try {
          await addPRCommentAsync(pr.repo, pr.number, body);
          statusMsg = `${ANSI.green}Comment posted on #${pr.number}${ANSI.reset}`;
        } catch {
          statusMsg = `${ANSI.red}Failed to post comment on #${pr.number}${ANSI.reset}`;
        }
        drawFooter(prevRowCount);
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

  function drawFooter(rowCount: number): void {
    const footerLine = ROW_START + Math.max(rowCount, 1) + currentDetailHeight + 1;
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(
      `${ANSI.dim}↑↓ select  ⏎ expand  [o]pen  [c]heckout  [C]omment  [r]erun  [u]pdate  [a]pprove  │  ` +
      `[R] all  [U] all  [q]uit${ANSI.reset}`
    );
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    if (statusMsg) process.stdout.write(statusMsg);
    process.stdout.write(`\x1b[${footerLine + 2};1H\x1b[J`);
  }

  function clampSelection(): void {
    if (currentPRs.length === 0) {
      selectedIndex = 0;
    } else {
      selectedIndex = Math.min(selectedIndex, currentPRs.length - 1);
    }
  }

  function refresh(): void {
    ciGeneration++;
    const gen = ciGeneration;
    ciUpdatePending = true;

    (async () => {
      try {
        const prs: PRWithStatus[] = [];
        const now = Date.now();
        for (const repo of repos) {
          validateRepo(repo);
          const rawPRs = await listOpenPRsAsync(repo, STATUS_FIELDS);
          if (gen !== ciGeneration || isInterrupted()) return;
          const matching = filterPRs(rawPRs, { repo, agent: null, mineOnly });

          for (const pr of matching) {
            const mergeStateStatus = (pr as { mergeStateStatus?: string }).mergeStateStatus ?? "";
            const reviewDecision = (pr as { reviewDecision?: string }).reviewDecision ?? "REVIEW_REQUIRED";
            const updatedAt = (pr as { updatedAt?: string }).updatedAt ?? "";
            const ageDays = updatedAt
              ? Math.floor((now - new Date(updatedAt).getTime()) / (24 * 60 * 60 * 1000))
              : 0;

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
              ciStatus: "pending",
              conflicts: mergeStateStatus === "HAS_CONFLICTS",
              ageDays,
              stale: ageDays >= STALE_DAYS,
              readyToMerge: false,
              commentCount: 0,
            });
          }
        }

        const sortedPrs = sortPRs(prs);
        const oldRowCount = prevRowCount;
        currentPRs = sortedPrs;
        prevRowCount = sortedPrs.length;
        clampSelection();

        if (expandedPRNumber !== null) {
          const newIdx = currentPRs.findIndex(p => p.number === expandedPRNumber);
          if (newIdx === -1) {
            expandedIndex = null;
            expandedPRNumber = null;
            detailComments = [];
            currentDetailHeight = 0;
          } else {
            expandedIndex = newIdx;
          }
        }

        drawAllRows();
        drawDetailSection();

        if (oldRowCount > sortedPrs.length) {
          for (let i = sortedPrs.length; i < oldRowCount; i++) {
            process.stdout.write(`\x1b[${ROW_START + i};1H\x1b[2K`);
          }
        }

        if (sortedPrs.length === 0) {
          process.stdout.write(`\x1b[${ROW_START};1H\x1b[2K`);
          process.stdout.write("No agent PRs found.");
        }
        drawFooter(Math.max(sortedPrs.length, 1));

        if (sortedPrs.length === 0) return;

        // Comment counts phase
        if (gen !== ciGeneration || isInterrupted()) return;
        const byRepo = new Map<string, PRWithStatus[]>();
        for (const pr of currentPRs) {
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
        drawDetailSection();

        // CI status phase — one PR at a time
        for (let i = 0; i < currentPRs.length; i++) {
          if (gen !== ciGeneration || isInterrupted()) break;
          const pr = currentPRs[i];
          try {
            const runs = await listWorkflowRunsAsync(pr.repo, pr.headRefName);
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
          } catch { /* leave as pending */ }

          if (gen !== ciGeneration || isInterrupted()) break;
          drawRow(i);
        }
      } catch (e: unknown) {
        if (isInterrupted()) return;
        const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
        const errLine = ROW_START + Math.max(prevRowCount, 0);
        process.stdout.write(`\x1b[${errLine};1H\x1b[2K`);
        console.error(`\x1b[33mAPI error, will retry: ${msg}\x1b[0m`);
      } finally {
        if (gen === ciGeneration) ciUpdatePending = false;
        if (isInterrupted()) cleanup();
      }
    })();
  }

  function moveSelection(delta: number): void {
    if (currentPRs.length === 0) return;
    const prev = selectedIndex;
    selectedIndex = Math.max(0, Math.min(currentPRs.length - 1, selectedIndex + delta));
    if (prev !== selectedIndex) {
      if (expandedIndex !== null) collapseDetail();
      drawRow(prev);
      drawRow(selectedIndex);
    }
  }

  function selectedPR(): PRWithStatus | null {
    return currentPRs[selectedIndex] ?? null;
  }

  function handleOpenSelected(): void {
    const pr = selectedPR();
    if (!pr) return;
    (async () => {
      try {
        await ghQuietAsync("pr", "view", String(pr.number), "--repo", pr.repo, "--web");
        statusMsg = `${ANSI.green}Opened #${pr.number} in browser${ANSI.reset}`;
      } catch {
        statusMsg = `${ANSI.red}Failed to open #${pr.number}${ANSI.reset}`;
      }
      drawFooter(prevRowCount);
    })();
  }

  function handleRerunSelected(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    if (pr.ciStatus !== "fail") {
      statusMsg = `${ANSI.dim}#${pr.number} has no failed CI to rerun${ANSI.reset}`;
      drawFooter(prevRowCount);
      return;
    }

    pr.ciStatus = "pending";
    drawRow(selectedIndex);

    busy = true;
    statusMsg = `${ANSI.amber}Rerunning failed workflows for #${pr.number}…${ANSI.reset}`;
    drawFooter(prevRowCount);

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
      drawFooter(prevRowCount);
    })();
  }

  function handleUpdateSelected(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    busy = true;
    statusMsg = `${ANSI.amber}Merging main into #${pr.number}…${ANSI.reset}`;
    drawFooter(prevRowCount);

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
      drawFooter(prevRowCount);
    })();
  }

  function handleApproveSelected(): void {
    const pr = selectedPR();
    if (busy || !pr) return;
    busy = true;
    statusMsg = `${ANSI.amber}Enabling merge when ready for #${pr.number}…${ANSI.reset}`;
    drawFooter(prevRowCount);

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
      drawFooter(prevRowCount);
    })();
  }

  function handleRerunAllFailed(): void {
    if (busy || currentPRs.length === 0) return;

    const toRerun: PRWithStatus[] = [];
    let skipped = 0;
    for (const pr of currentPRs) {
      if (pr.ciStatus !== "fail") continue;
      if (pr.stale) { skipped++; continue; }
      toRerun.push(pr);
    }

    if (toRerun.length === 0) {
      statusMsg = skipped > 0
        ? `${ANSI.dim}Skipped ${skipped} stale, no failed workflows to rerun${ANSI.reset}`
        : `${ANSI.dim}No failed workflows to rerun${ANSI.reset}`;
      drawFooter(prevRowCount);
      return;
    }

    for (const pr of toRerun) pr.ciStatus = "pending";
    drawAllRows();

    busy = true;
    statusMsg = `${ANSI.amber}Rerunning all failed workflows…${ANSI.reset}`;
    drawFooter(prevRowCount);

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
      drawFooter(prevRowCount);
      await new Promise(r => setTimeout(r, BULK_COOLDOWN_MS));
      refresh();
    })();
  }

  function handleUpdateAllMain(): void {
    if (busy || currentPRs.length === 0) return;
    busy = true;
    statusMsg = `${ANSI.amber}Merging main into all PR branches…${ANSI.reset}`;
    drawFooter(prevRowCount);

    (async () => {
      try {
        let updated = 0;
        let upToDate = 0;
        for (const pr of currentPRs) {
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
      drawFooter(prevRowCount);
      await new Promise(r => setTimeout(r, BULK_COOLDOWN_MS));
      refresh();
    })();
  }

  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
  console.log(TITLE + "\n");
  console.log(buildTableHeader(singleRepo));
  console.log(tableSeparator());
  process.stdout.write(`\x1b[${ROW_START};1H${ANSI.dim}Loading…${ANSI.reset}`);
  drawFooter(1);

  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    process.stdin.on("data", (key: string) => {
      if (commentInputMode) {
        handleCommentKey(key);
        return;
      }

      if (key === "q" || key === "\x03") cleanup();

      if (key === "\x1b[A" || key === "k") { moveSelection(-1); return; }
      if (key === "\x1b[B" || key === "j") { moveSelection(1); return; }

      if (busy) return;

      if (key === "\r") { handleToggleExpand(); return; }
      if (key === "o") { handleOpenSelected(); return; }
      if (key === "c") { handleCheckout(); return; }
      if (key === "C") { startCommentInput(); return; }
      if (key === "r") { handleRerunSelected(); return; }
      if (key === "u") { handleUpdateSelected(); return; }
      if (key === "a") { handleApproveSelected(); return; }

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
  ↑↓/jk navigate  ⏎ expand  [o]pen  [c]heckout  [C]omment
  [r]erun  [u]pdate main  [a]pprove
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
