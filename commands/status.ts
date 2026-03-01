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
}

export type Urgency = "red" | "amber" | "green";

function getUrgency(pr: PRWithStatus): Urgency {
  if (pr.ciStatus === "fail" || pr.conflicts) return "red";
  if (pr.stale || pr.reviewDecision === "CHANGES_REQUESTED" || pr.ciStatus === "pending") return "amber";
  return "green";
}

function sortPRs(prs: PRWithStatus[]): PRWithStatus[] {
  return prs.sort((a, b) => {
    return a.ageDays - b.ageDays;
  });
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

function fetchPRsWithStatus(repos: string[], mineOnly: boolean): PRWithStatus[] {
  const prs = fetchPRsBase(repos, mineOnly);
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

function formatCI(pr: PRWithStatus): string {
  if (pr.ciStatus === "pass") return `${ANSI.green}✓${ANSI.reset}`;
  if (pr.ciStatus === "fail") return `${ANSI.red}✗${ANSI.reset}`;
  if (pr.ciStatus === "pending") return `${ANSI.amber}⏳${ANSI.reset}`;
  return `${ANSI.dim}—${ANSI.reset}`;
}

function formatReview(pr: PRWithStatus): string {
  const r = pr.reviewDecision;
  if (r === "APPROVED") return `${ANSI.green}✓${ANSI.reset}`;
  if (r === "CHANGES_REQUESTED") return `${ANSI.amber}!${ANSI.reset}`;
  return `${ANSI.dim}○${ANSI.reset}`;
}

function formatPRRow(pr: PRWithStatus): string {
  const urgency = getUrgency(pr);
  const color = ANSI[urgency];
  const repoShort = pr.repo.length > 18 ? pr.repo.slice(0, 15) + "…" : pr.repo.padEnd(18);
  const agent = (pr.agent ?? "?").padEnd(7);
  const ci = formatCI(pr);
  const rev = formatReview(pr);
  const con = pr.conflicts ? `${ANSI.red}✗${ANSI.reset}` : `${ANSI.green}—${ANSI.reset}`;
  const age = pr.ageDays >= STALE_DAYS ? `${ANSI.amber}${pr.ageDays}d${ANSI.reset}` : `${pr.ageDays}d`;
  const titleShort = pr.title.slice(0, 35) + (pr.title.length > 35 ? "…" : "");
  return `${color}${repoShort} #${String(pr.number).padEnd(4)} ${agent} ${ci}   ${rev}   ${con}   ${age.padEnd(4)} ${titleShort}${ANSI.reset}`;
}

const TABLE_HEADER = `${ANSI.bold}REPO               #  AGENT    CI  REV  CON  AGE  TITLE${ANSI.reset}`;
const TABLE_SEPARATOR = "-".repeat(80);

function renderTable(prs: PRWithStatus[]): void {
  if (prs.length === 0) {
    console.log("No agent PRs found.");
    return;
  }

  console.log(TABLE_HEADER);
  console.log(TABLE_SEPARATOR);
  for (const pr of prs) {
    console.log(formatPRRow(pr));
  }
}

function runOnce(repos: string[], mineOnly: boolean): void {
  const prs = fetchPRsWithStatus(repos, mineOnly);
  renderTable(prs);
}

function runWatch(repos: string[], mineOnly: boolean): void {
  const TITLE = `copse status — refresh every ${WATCH_INTERVAL_MS / 1000}s (Ctrl+C to quit)`;
  // line 1 = TITLE, 2 = blank, 3 = table header, 4 = separator, 5+ = rows
  const ROW_START = 5;
  let prevRowCount = -1;

  function refresh(): void {
    try {
      const prs = fetchPRsBase(repos, mineOnly);

      if (prevRowCount < 0) {
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(TITLE + "\n");
        console.log(TABLE_HEADER);
        console.log(TABLE_SEPARATOR);
      }

      for (let i = 0; i < prs.length; i++) {
        try { updatePRCIStatus(prs[i]); } catch { /* leave as pending */ }
        process.stdout.write(`\x1b[${ROW_START + i};1H\x1b[2K${formatPRRow(prs[i])}`);
      }

      if (prevRowCount > prs.length) {
        for (let i = prs.length; i < prevRowCount; i++) {
          process.stdout.write(`\x1b[${ROW_START + i};1H\x1b[2K`);
        }
      }

      prevRowCount = prs.length;
      process.stdout.write(`\x1b[${ROW_START + prs.length};1H\x1b[2K`);
      if (prs.length === 0) console.log("No agent PRs found.");
    } catch (e: unknown) {
      const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
      const errLine = ROW_START + Math.max(prevRowCount, 0);
      process.stdout.write(`\x1b[${errLine};1H\x1b[2K`);
      console.error(`\x1b[33mAPI error, will retry: ${msg}\x1b[0m`);
    }
  }

  function loop(): void {
    refresh();
    setTimeout(loop, WATCH_INTERVAL_MS);
  }

  loop();
}

function main(): void {
  const { flags, filtered } = parseStandardFlags(process.argv.slice(2));
  const { mineOnly } = flags;
  const watch = filtered.includes("--watch");
  const filteredArgs = filtered.filter((a) => a !== "--watch");

  const help = `Usage: status [options]

  Unified dashboard across all configured repos. Shows every open agent PR with
  CI status, review state, conflicts, age, and merge-readiness.

  Uses origin remote when run inside a git repo (including submodules).
  Falls back to .copserc in cwd or parent: { "repos": ["owner/name", ...] }

Options:
  --watch   Live refresh (clear + redraw every 10s). Ctrl+C to quit.
  --mine    Only your PRs (default)
  --all     Include PRs from all authors
`;

  let repos: string[] = [];

  if (filteredArgs.length >= 1 && REPO_PATTERN.test(filteredArgs[0])) {
    repos = [filteredArgs[0]];
  } else {
    // Prefer current directory's git origin (works for submodules) over parent .copserc
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
