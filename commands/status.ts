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

function fetchPRsWithStatus(
  repos: string[],
  mineOnly: boolean
): PRWithStatus[] {
  const result: PRWithStatus[] = [];
  const now = Date.now();

  for (const repo of repos) {
    validateRepo(repo);
    const rawPRs = listOpenPRs(repo, STATUS_FIELDS);
    const matching = filterPRs(rawPRs, { agent: null, mineOnly });

    for (const pr of matching) {
      const agent = getAgentForPR(pr);
      const runs = listWorkflowRuns(repo, pr.headRefName);
      const failed = runs.filter((r) => r.conclusion === "failure");
      const inProgress = runs.filter(
        (r) => r.status === "in_progress" || r.status === "queued" || r.status === "requested"
      );

      let ciStatus: PRWithStatus["ciStatus"] = "none";
      if (failed.length > 0) ciStatus = "fail";
      else if (inProgress.length > 0) ciStatus = "pending";
      else if (runs.some((r) => r.conclusion === "success")) ciStatus = "pass";

      const mergeStateStatus = (pr as { mergeStateStatus?: string }).mergeStateStatus ?? "";
      const conflicts = mergeStateStatus === "HAS_CONFLICTS";
      const reviewDecision = (pr as { reviewDecision?: string }).reviewDecision ?? "REVIEW_REQUIRED";
      const updatedAt = (pr as { updatedAt?: string }).updatedAt ?? "";
      const ageDays = updatedAt
        ? Math.floor((now - new Date(updatedAt).getTime()) / (24 * 60 * 60 * 1000))
        : 0;
      const stale = ageDays >= STALE_DAYS;
      const readyToMerge =
        ciStatus === "pass" &&
        !conflicts &&
        (reviewDecision === "APPROVED" || reviewDecision === null);

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
        agent,
        ciStatus,
        conflicts,
        ageDays,
        stale,
        readyToMerge,
      });
    }
  }

  return result.sort((a, b) => {
    const ua = getUrgency(a);
    const ub = getUrgency(b);
    const order = { red: 0, amber: 1, green: 2 };
    if (order[ua] !== order[ub]) return order[ua] - order[ub];
    return b.ageDays - a.ageDays;
  });
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

function renderTable(prs: PRWithStatus[]): void {
  if (prs.length === 0) {
    console.log("No agent PRs found.");
    return;
  }

  const header = `${ANSI.bold}REPO               #  AGENT    CI  REV  CON  AGE  TITLE${ANSI.reset}`;
  console.log(header);
  console.log("-".repeat(80));

  for (const pr of prs) {
    const urgency = getUrgency(pr);
    const color = ANSI[urgency];
    const repoShort = pr.repo.length > 18 ? pr.repo.slice(0, 15) + "…" : pr.repo.padEnd(18);
    const agent = (pr.agent ?? "?").padEnd(7);
    const ci = formatCI(pr);
    const rev = formatReview(pr);
    const con = pr.conflicts ? `${ANSI.red}✗${ANSI.reset}` : `${ANSI.green}—${ANSI.reset}`;
    const age = pr.ageDays >= STALE_DAYS ? `${ANSI.amber}${pr.ageDays}d${ANSI.reset}` : `${pr.ageDays}d`;
    const titleShort = pr.title.slice(0, 35) + (pr.title.length > 35 ? "…" : "");
    console.log(`${color}${repoShort} #${String(pr.number).padEnd(4)} ${agent} ${ci}   ${rev}   ${con}   ${age.padEnd(4)} ${titleShort}${ANSI.reset}`);
  }
}

function runOnce(repos: string[], mineOnly: boolean): void {
  const prs = fetchPRsWithStatus(repos, mineOnly);
  renderTable(prs);
}

function runWatch(repos: string[], mineOnly: boolean): void {
  const clearAndHome = "\x1b[2J\x1b[H";

  function refresh(): void {
    process.stdout.write(clearAndHome);
    const prs = fetchPRsWithStatus(repos, mineOnly);
    console.log(`copse status — refresh every ${WATCH_INTERVAL_MS / 1000}s (Ctrl+C to quit)\n`);
    renderTable(prs);
  }

  refresh();
  setInterval(refresh, WATCH_INTERVAL_MS);
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
