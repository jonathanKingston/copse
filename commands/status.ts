/**
 * Unified dashboard: full picture of agent PRs across all configured repos.
 * Usage: copse status [options]
 *        --watch  Live refresh (clear + redraw every 30s)
 */

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
  isInterrupted,
  setPipeStdio,
} from "../lib/gh.js";
import type { WorkflowRun } from "../lib/types.js";
import { filterPRs, getUserForDisplay, buildFetchMessage } from "../lib/filters.js";
import { getConfiguredRepos } from "../lib/config.js";
import { getOriginRepo } from "../lib/utils.js";
import { parseStandardFlags } from "../lib/args.js";

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

  function drawFooter(rowCount: number): void {
    const footerLine = ROW_START + Math.max(rowCount, 1) + 1;
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(
      `${ANSI.dim}↑↓ select  ⏎/o open  [r]erun  [u]pdate main  [a]pprove  │  ` +
      `[R]erun all  [U]pdate all  [q]uit${ANSI.reset}`
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

        drawAllRows();

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
      if (key === "q" || key === "\x03") cleanup();

      if (key === "\x1b[A" || key === "k") { moveSelection(-1); return; }
      if (key === "\x1b[B" || key === "j") { moveSelection(1); return; }

      if (busy) return;

      if (key === "\r" || key === "o") { handleOpenSelected(); return; }
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
  const watch = filtered.includes("--watch");
  const filteredArgs = filtered.filter((a) => a !== "--watch");

  const help = `Usage: status [options]

  Unified dashboard across all configured repos. Shows every open agent PR with
  CI status, review state, conflicts, age, comments, and merge-readiness.

  Uses origin remote when run inside a git repo (including submodules).
  Falls back to .copserc in cwd or parent: { "repos": ["owner/name", ...] }

Options:
  --watch   Live refresh (clear + redraw every 30s).
            ↑↓/jk navigate  ⏎/o open  [r]erun  [u]pdate main  [a]pprove
            [R]erun all  [U]pdate all  [q]uit
  --mine    Only your PRs (default)
  --all     Include PRs from all authors
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
