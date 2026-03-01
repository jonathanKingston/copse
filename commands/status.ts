/**
 * Unified dashboard: full picture of agent PRs across all configured repos.
 * Usage: copse status [options]
 *        --watch  Live refresh (clear + redraw every 10s)
 */

import {
  listOpenPRs,
  listWorkflowRuns,
  getAgentForPR,
  validateRepo,
  REPO_PATTERN,
  gh,
  ghQuiet,
  getUnresolvedCommentCounts,
  isInterrupted,
} from "../lib/gh.js";
import { filterPRs, getUserForDisplay, buildFetchMessage } from "../lib/filters.js";
import { getConfiguredRepos } from "../lib/config.js";
import { getOriginRepo } from "../lib/utils.js";
import { parseStandardFlags } from "../lib/args.js";

const STATUS_FIELDS = [
  "number", "headRefName", "labels", "title", "author",
  "mergeStateStatus", "mergeable", "reviewDecision", "createdAt", "updatedAt",
];

const STALE_DAYS = 7;
const WATCH_INTERVAL_MS = 10_000;

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
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "").length;
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

function formatPRRow(pr: PRWithStatus, singleRepo: boolean): string {
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
  const titleShort = pr.title.slice(0, 35) + (pr.title.length > 35 ? "…" : "");
  return `${color}${repoPart}${prNum} ${agent} ${ci}   ${rev}   ${con}   ${pad(age, 4)} ${pad(cmt, 3)} ${titleShort}${ANSI.reset}`;
}

function buildTableHeader(singleRepo: boolean): string {
  const repoPart = singleRepo ? "" : "REPO               ";
  return `${ANSI.bold}${repoPart}#     AGENT   CI  REV CON AGE  CMT TITLE${ANSI.reset}`;
}

const TABLE_SEPARATOR = "-".repeat(80);

function renderTable(prs: PRWithStatus[], singleRepo: boolean): void {
  if (prs.length === 0) {
    console.log("No agent PRs found.");
    return;
  }

  console.log(buildTableHeader(singleRepo));
  console.log(TABLE_SEPARATOR);
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
  let prevRowCount = -1;
  let currentPRs: PRWithStatus[] = [];
  let statusMsg = "";
  let busy = false;
  const isTTY = !!process.stdin.isTTY;

  function cleanup(): void {
    if (isTTY) try { process.stdin.setRawMode(false); } catch {}
    process.stdout.write("\x1b[?25h\n");
    process.exit(0);
  }

  process.on("SIGINT", cleanup);

  function rawMode(on: boolean): void {
    if (isTTY) try { process.stdin.setRawMode(on); } catch {}
  }

  function drawFooter(rowCount: number): void {
    const footerLine = ROW_START + Math.max(rowCount, 1) + 1;
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    process.stdout.write(`${ANSI.dim}[r] rerun failed  [u] update main  [q] quit${ANSI.reset}`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    if (statusMsg) process.stdout.write(statusMsg);
    process.stdout.write(`\x1b[${footerLine + 2};1H\x1b[J`);
  }

  function refresh(): void {
    rawMode(false);
    try {
      const prs = fetchPRsBase(repos, mineOnly);
      if (isInterrupted()) return;
      updateCommentCounts(prs);
      if (isInterrupted()) return;

      if (prevRowCount < 0) {
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(TITLE + "\n");
        console.log(buildTableHeader(singleRepo));
        console.log(TABLE_SEPARATOR);
      }

      for (let i = 0; i < prs.length; i++) {
        if (isInterrupted()) break;
        try { updatePRCIStatus(prs[i]); } catch { /* leave as pending */ }
        process.stdout.write(`\x1b[${ROW_START + i};1H\x1b[2K${formatPRRow(prs[i], singleRepo)}`);
      }

      if (isInterrupted()) return;

      if (prevRowCount > prs.length) {
        for (let i = prs.length; i < prevRowCount; i++) {
          process.stdout.write(`\x1b[${ROW_START + i};1H\x1b[2K`);
        }
      }

      currentPRs = prs;
      prevRowCount = prs.length;

      if (prs.length === 0) {
        process.stdout.write(`\x1b[${ROW_START};1H\x1b[2K`);
        process.stdout.write("No agent PRs found.");
        drawFooter(1);
      } else {
        drawFooter(prs.length);
      }
    } catch (e: unknown) {
      if (isInterrupted()) return;
      const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
      const errLine = ROW_START + Math.max(prevRowCount, 0);
      process.stdout.write(`\x1b[${errLine};1H\x1b[2K`);
      console.error(`\x1b[33mAPI error, will retry: ${msg}\x1b[0m`);
    } finally {
      if (isInterrupted()) { cleanup(); return; }
      rawMode(true);
    }
  }

  function handleRerunFailed(): void {
    if (busy || currentPRs.length === 0) return;
    busy = true;
    statusMsg = `${ANSI.amber}Rerunning failed workflows...${ANSI.reset}`;
    drawFooter(prevRowCount);

    rawMode(false);
    try {
      let total = 0;
      let skipped = 0;
      for (const pr of currentPRs) {
        if (isInterrupted()) break;
        if (pr.ciStatus !== "fail") continue;
        if (pr.stale) { skipped++; continue; }
        const runs = listWorkflowRuns(pr.repo, pr.headRefName);
        const failed = runs.filter(r => r.conclusion === "failure");
        for (const run of failed) {
          if (isInterrupted()) break;
          try {
            ghQuiet("run", "rerun", String(run.databaseId), "--repo", pr.repo, "--failed");
            total++;
          } catch { /* skip */ }
        }
      }

      const parts: string[] = [];
      if (total > 0) parts.push(`reran ${total} workflow(s)`);
      if (skipped > 0) parts.push(`skipped ${skipped} stale`);
      statusMsg = total > 0
        ? `${ANSI.green}${parts.join(", ")}${ANSI.reset}`
        : `${ANSI.dim}${parts.length > 0 ? parts.join(", ") : "no failed workflows to rerun"}${ANSI.reset}`;
    } finally {
      if (isInterrupted()) { cleanup(); return; }
      rawMode(true);
    }
    busy = false;
    refresh();
  }

  function handleUpdateMain(): void {
    if (busy || currentPRs.length === 0) return;
    busy = true;
    statusMsg = `${ANSI.amber}Merging main into PR branches...${ANSI.reset}`;
    drawFooter(prevRowCount);

    rawMode(false);
    try {
      let updated = 0;
      let upToDate = 0;
      for (const pr of currentPRs) {
        if (isInterrupted()) break;
        try {
          ghQuiet("api", `repos/${pr.repo}/merges`, "-f", `base=${pr.headRefName}`, "-f", "head=main");
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
      rawMode(true);
    }
    busy = false;
    refresh();
  }

  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\x03") cleanup();
      if (busy) return;
      if (key === "r") handleRerunFailed();
      if (key === "u") handleUpdateMain();
    });
  }

  refresh();

  function loop(): void {
    if (isInterrupted()) { cleanup(); return; }
    if (!busy) refresh();
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
  --watch   Live refresh (clear + redraw every 10s).
            Keyboard: [r] rerun failed  [u] update main  [q] quit
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
