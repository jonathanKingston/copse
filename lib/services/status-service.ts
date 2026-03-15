import {
  AGENT_BRANCH_PATTERNS,
  branchHasUniqueCommits,
  branchHasUniqueCommitsAsync,
  hasNewerMergeCommitForBranch,
  hasNewerMergeCommitForBranchAsync,
  getAgentForPR,
  getCurrentUser,
  getCommitInfo,
  getCommitInfoAsync,
  getDefaultBranch,
  getDefaultBranchAsync,
  getUnresolvedCommentCounts,
  getUnresolvedCommentCountsAsync,
  listBranches,
  listBranchesAsync,
  listOpenPRs,
  listOpenPRsAsync,
  listWorkflowRuns,
  listWorkflowRunsAsync,
  validateRepo,
} from "../gh.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "../types.js";
import {
  STALE_DAYS,
  WATCH_INTERVAL_MS,
  STATUS_FIELDS,
  type BranchWithStatus,
  type PRWithStatus,
  type StatusRow,
  type StatusBasePR,
  type StatusFilterScope,
  isPRWithStatus,
} from "./status-types.js";

export interface StatusQueryOptions {
  repos: string[];
  scope: StatusFilterScope;
}

interface CacheEntry {
  result: StatusRow[];
  expiresAt: number;
}

interface SerializedCacheEntry extends CacheEntry {
  key: string;
}

const statusCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<StatusRow[]>>();
const STATUS_CACHE_DIR = join(tmpdir(), "copse", "status-cache");
let diskCacheDirPromise: Promise<string | null> | null = null;

function cacheKey(options: StatusQueryOptions): string {
  return `${[...options.repos].sort().join(",")}\0${options.scope}`;
}

export function invalidateStatusCache(): void {
  statusCache.clear();
  inflightRequests.clear();
  void clearDiskStatusCache();
}

function sortRows(rows: StatusRow[]): StatusRow[] {
  return rows.sort((a, b) => {
    if (a.ageDays !== b.ageDays) return a.ageDays - b.ageDays;
    if (a.rowType !== b.rowType) return a.rowType === "pr" ? -1 : 1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return a.headRefName.localeCompare(b.headRefName);
  });
}

function cacheFileName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

async function getDiskCacheDir(): Promise<string | null> {
  if (!diskCacheDirPromise) {
    diskCacheDirPromise = mkdir(STATUS_CACHE_DIR, { recursive: true })
      .then(() => STATUS_CACHE_DIR)
      .catch(() => null);
  }
  return diskCacheDirPromise;
}

function isValidCacheEntry(value: unknown): value is SerializedCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SerializedCacheEntry>;
  return (
    typeof entry.key === "string" &&
    typeof entry.expiresAt === "number" &&
    Array.isArray(entry.result)
  );
}

function isCacheFresh(entry: CacheEntry, now: number = Date.now()): boolean {
  return entry.expiresAt > now;
}

async function readDiskStatusCache(key: string, allowStale: boolean = false): Promise<CacheEntry | null> {
  const dir = await getDiskCacheDir();
  if (!dir) return null;

  try {
    const raw = await readFile(join(dir, cacheFileName(key)), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidCacheEntry(parsed) || parsed.key !== key) {
      return null;
    }
    if (!allowStale && !isCacheFresh(parsed)) {
      return null;
    }
    return {
      result: parsed.result,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function writeDiskStatusCache(key: string, entry: CacheEntry): Promise<void> {
  const dir = await getDiskCacheDir();
  if (!dir) return;

  const finalPath = join(dir, cacheFileName(key));
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    const payload = JSON.stringify({ key, ...entry });
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, finalPath);
  } catch {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cache cleanup failures and keep using in-memory cache.
    }
  }
}

async function clearDiskStatusCache(): Promise<void> {
  const dir = await getDiskCacheDir();
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cache cleanup failures and keep serving fresh data.
  }
}

export function applyCIStatus(row: StatusRow, runs: WorkflowRun[]): void {
  const failed = runs.filter((r) => r.conclusion === "failure");
  const inProgress = runs.filter(
    (r) => r.status === "in_progress" || r.status === "queued" || r.status === "requested"
  );

  if (failed.length > 0) row.ciStatus = "fail";
  else if (inProgress.length > 0) row.ciStatus = "pending";
  else if (runs.some((r) => r.conclusion === "success")) row.ciStatus = "pass";
  else row.ciStatus = "none";

  if (!isPRWithStatus(row)) {
    return;
  }

  row.readyToMerge =
    row.ciStatus === "pass" &&
    !row.conflicts &&
    (row.reviewDecision === "APPROVED" || row.reviewDecision === null);
}

export function hasPRConflicts(raw: Pick<StatusBasePR, "mergeStateStatus" | "mergeable">): boolean {
  const mergeable = raw.mergeable ?? "UNKNOWN";
  if (mergeable === "CONFLICTING") return true;
  if (mergeable === "MERGEABLE") return false;
  return (raw.mergeStateStatus ?? "") === "HAS_CONFLICTS";
}

function getAgentForBranch(headRefName: string): string | null {
  for (const [agent, pattern] of Object.entries(AGENT_BRANCH_PATTERNS)) {
    if (pattern.test(headRefName)) {
      return agent;
    }
  }
  return null;
}

function commitTitle(message: string | undefined, fallback: string): string {
  const title = String(message || "").split("\n")[0]?.trim() || "";
  return title || fallback;
}

export function filterStandaloneBranches(branches: string[], prs: Pick<StatusBasePR, "headRefName" | "baseRefName">[]): string[] {
  return filterStandaloneBranchesWithoutMerged(branches, prs, []);
}

export function filterStandaloneBranchesWithoutMerged(
  branches: string[],
  prs: Pick<StatusBasePR, "headRefName" | "baseRefName">[],
  mergedBranches: Iterable<string>
): string[] {
  const prHeadBranches = new Set<string>();
  for (const pr of prs) {
    prHeadBranches.add(pr.headRefName);
  }
  const mergedBranchSet = new Set(mergedBranches);

  return branches.filter(
    (branch) => getAgentForBranch(branch) && !prHeadBranches.has(branch) && !mergedBranchSet.has(branch)
  );
}

function getMergedStandaloneBranches(
  repo: string,
  branches: string[],
  defaultBranch: string
): Set<string> {
  const mergedBranches = new Set<string>();
  for (const branch of branches) {
    try {
      if (!branchHasUniqueCommits(repo, defaultBranch, branch)) {
        mergedBranches.add(branch);
        continue;
      }
      const branchTip = getCommitInfo(repo, branch);
      if (branchTip.date && hasNewerMergeCommitForBranch(repo, defaultBranch, branch, branchTip.date)) {
        mergedBranches.add(branch);
      }
    } catch {
      // Keep uncertain branches visible rather than hiding actionable work.
    }
  }
  return mergedBranches;
}

async function getMergedStandaloneBranchesAsync(
  repo: string,
  branches: string[],
  defaultBranch: string
): Promise<Set<string>> {
  const merged = await Promise.all(
    branches.map(async (branch) => {
      try {
        if (!await branchHasUniqueCommitsAsync(repo, defaultBranch, branch)) {
          return branch;
        }
        const branchTip = await getCommitInfoAsync(repo, branch);
        if (branchTip.date && await hasNewerMergeCommitForBranchAsync(repo, defaultBranch, branch, branchTip.date)) {
          return branch;
        }
        return null;
      } catch {
        // Keep uncertain branches visible rather than hiding actionable work.
        return null;
      }
    })
  );
  return new Set(merged.filter((branch): branch is string => branch !== null));
}

function toPRWithStatus(repo: string, raw: StatusBasePR, now: number): PRWithStatus {
  const mergeStateStatus = raw.mergeStateStatus ?? "";
  const mergeable = raw.mergeable ?? "UNKNOWN";
  const reviewDecision = raw.reviewDecision ?? "REVIEW_REQUIRED";
  const createdAt = raw.createdAt ?? "";
  const updatedAt = raw.updatedAt ?? "";
  const ageDays = createdAt
    ? Math.floor((now - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    rowType: "pr",
    repo,
    number: raw.number,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName ?? "",
    labels: (raw.labels || []).map((label) => label.name).filter(Boolean),
    title: raw.title ?? "",
    author: raw.author,
    isDraft: raw.isDraft === true,
    mergeStateStatus,
    mergeable,
    reviewDecision,
    updatedAt,
    agent: getAgentForPR(raw),
    autoMerge: raw.autoMergeRequest != null,
    ciStatus: "pending",
    conflicts: hasPRConflicts({ mergeStateStatus, mergeable }),
    ageDays,
    stale: ageDays >= STALE_DAYS,
    readyToMerge: false,
    commentCount: 0,
  };
}

function toBranchWithStatus(
  repo: string,
  headRefName: string,
  now: number,
  commitInfo: { message?: string; date: Date | null; authorLogin: string }
): BranchWithStatus {
  const updatedAt = commitInfo.date ? commitInfo.date.toISOString() : "";
  const ageDays = commitInfo.date
    ? Math.floor((now - commitInfo.date.getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    rowType: "branch",
    repo,
    headRefName,
    title: commitTitle(commitInfo.message, headRefName),
    author: { login: commitInfo.authorLogin || "unknown" },
    updatedAt,
    agent: getAgentForBranch(headRefName),
    ciStatus: "none",
    ageDays,
    stale: ageDays >= STALE_DAYS,
  };
}

export function filterPRsByStatusScope(
  prs: StatusBasePR[],
  scope: StatusFilterScope,
  currentUser: string
): StatusBasePR[] {
  if (scope === "all") {
    return prs;
  }

  const myPrs = prs.filter((pr) => (pr.author?.login ?? "") === currentUser);
  if (myPrs.length === 0) {
    return [];
  }

  const includedNumbers = new Set(myPrs.map((pr) => pr.number));
  const queuedBranches = myPrs.map((pr) => pr.headRefName);
  const childrenByBase = new Map<string, StatusBasePR[]>();

  for (const pr of prs) {
    const baseRefName = pr.baseRefName ?? "";
    if (!baseRefName) continue;
    const children = childrenByBase.get(baseRefName) ?? [];
    children.push(pr);
    childrenByBase.set(baseRefName, children);
  }

  for (let i = 0; i < queuedBranches.length; i++) {
    const branch = queuedBranches[i];
    const children = childrenByBase.get(branch) ?? [];
    for (const child of children) {
      if (includedNumbers.has(child.number)) continue;
      includedNumbers.add(child.number);
      queuedBranches.push(child.headRefName);
    }
  }

  return prs.filter((pr) => includedNumbers.has(pr.number));
}

function buildStandaloneBranchRowsSync(
  repo: string,
  prs: StatusBasePR[],
  now: number
): BranchWithStatus[] {
  const allBranches = listBranches(repo);
  const allCandidateBranches = filterStandaloneBranches(allBranches, prs);
  const defaultBranch = getDefaultBranch(repo);
  const mergedBranches = getMergedStandaloneBranches(repo, allCandidateBranches, defaultBranch);
  const candidateBranches = filterStandaloneBranchesWithoutMerged(allBranches, prs, mergedBranches);
  const rows: BranchWithStatus[] = [];

  for (const branch of candidateBranches) {
    try {
      const info = getCommitInfo(repo, branch, true);
      rows.push(toBranchWithStatus(repo, branch, now, info));
    } catch {
      // Keep the dashboard responsive when individual branch metadata cannot be loaded.
    }
  }

  return rows;
}

async function buildStandaloneBranchRows(
  repo: string,
  prs: StatusBasePR[],
  now: number
): Promise<BranchWithStatus[]> {
  const allBranches = await listBranchesAsync(repo);
  const allCandidateBranches = filterStandaloneBranches(allBranches, prs);
  const defaultBranch = await getDefaultBranchAsync(repo);
  const mergedBranches = await getMergedStandaloneBranchesAsync(repo, allCandidateBranches, defaultBranch);
  const candidateBranches = filterStandaloneBranchesWithoutMerged(allBranches, prs, mergedBranches);
  const rows = await Promise.all(candidateBranches.map(async (branch) => {
    try {
      const info = await getCommitInfoAsync(repo, branch, true);
      return toBranchWithStatus(repo, branch, now, info);
    } catch {
      return null;
    }
  }));

  return rows.filter((row): row is BranchWithStatus => row !== null);
}

export function fetchPRsWithStatusSync(options: StatusQueryOptions): StatusRow[] {
  const result: StatusRow[] = [];
  const now = Date.now();
  const currentUser = options.scope === "my-stacks" ? getCurrentUser() : "";

  for (const repo of options.repos) {
    validateRepo(repo);
    const rawPRs = listOpenPRs(repo, STATUS_FIELDS) as StatusBasePR[];
    const matching = filterPRsByStatusScope(rawPRs, options.scope, currentUser);
    for (const pr of matching) {
      result.push(toPRWithStatus(repo, pr, now));
    }
    result.push(...buildStandaloneBranchRowsSync(repo, rawPRs, now));
  }

  const byRepo = new Map<string, StatusRow[]>();
  for (const row of result) {
    const list = byRepo.get(row.repo) ?? [];
    list.push(row);
    byRepo.set(row.repo, list);
  }

  for (const [repo, repoRows] of byRepo) {
    const repoPrs = repoRows.filter(isPRWithStatus);
    try {
      const counts = getUnresolvedCommentCounts(repo, repoPrs.map(p => p.number));
      for (const pr of repoPrs) {
        pr.commentCount = counts.get(pr.number) ?? 0;
      }
    } catch {
      // Keep the default value when comments cannot be fetched.
    }
  }

  const branchCache = new Map<string, WorkflowRun[]>();
  for (const row of result) {
    const key = `${row.repo}\0${row.headRefName}`;
    let runs = branchCache.get(key);
    if (runs === undefined) {
      try {
        runs = listWorkflowRuns(row.repo, row.headRefName);
      } catch {
        runs = [];
      }
      branchCache.set(key, runs);
    }
    applyCIStatus(row, runs);
  }

  return sortRows(result);
}

async function fetchPRsWithStatusUncached(options: StatusQueryOptions): Promise<StatusRow[]> {
  const result: StatusRow[] = [];
  const now = Date.now();
  const currentUser = options.scope === "my-stacks" ? getCurrentUser() : "";

  for (const repo of options.repos) {
    validateRepo(repo);
    const rawPRs = await listOpenPRsAsync(repo, STATUS_FIELDS) as StatusBasePR[];
    const matching = filterPRsByStatusScope(rawPRs, options.scope, currentUser);
    for (const pr of matching) {
      result.push(toPRWithStatus(repo, pr, now));
    }
    result.push(...await buildStandaloneBranchRows(repo, rawPRs, now));
  }

  const byRepo = new Map<string, StatusRow[]>();
  for (const row of result) {
    const list = byRepo.get(row.repo) ?? [];
    list.push(row);
    byRepo.set(row.repo, list);
  }

  for (const [repo, repoRows] of byRepo) {
    const repoPrs = repoRows.filter(isPRWithStatus);
    try {
      const counts = await getUnresolvedCommentCountsAsync(repo, repoPrs.map(p => p.number));
      for (const pr of repoPrs) {
        pr.commentCount = counts.get(pr.number) ?? 0;
      }
    } catch {
      // Keep the default value when comments cannot be fetched.
    }
  }

  const branchCache = new Map<string, WorkflowRun[]>();
  for (const row of result) {
    const key = `${row.repo}\0${row.headRefName}`;
    let runs = branchCache.get(key);
    if (runs === undefined) {
      try {
        runs = await listWorkflowRunsAsync(row.repo, row.headRefName);
      } catch {
        runs = [];
      }
      branchCache.set(key, runs);
    }
    applyCIStatus(row, runs);
  }

  return sortRows(result);
}

function startStatusRefresh(key: string, options: StatusQueryOptions): Promise<StatusRow[]> {
  const promise = fetchPRsWithStatusUncached(options).then(
    (result) => {
      const entry = { result, expiresAt: Date.now() + WATCH_INTERVAL_MS };
      statusCache.set(key, entry);
      inflightRequests.delete(key);
      void writeDiskStatusCache(key, entry);
      return result;
    },
    (error) => {
      inflightRequests.delete(key);
      throw error;
    },
  );

  inflightRequests.set(key, promise);
  return promise;
}

export async function fetchPRsWithStatus(options: StatusQueryOptions): Promise<StatusRow[]> {
  const key = cacheKey(options);
  let cached = statusCache.get(key) ?? null;

  if (cached && isCacheFresh(cached)) {
    return cached.result;
  }

  let inflight = inflightRequests.get(key);
  if (inflight) {
    return cached ? cached.result : inflight;
  }

  if (!cached) {
    const diskCached = await readDiskStatusCache(key, true);
    if (diskCached) {
      statusCache.set(key, diskCached);
      cached = diskCached;
      if (isCacheFresh(diskCached)) {
        return diskCached.result;
      }
    }
  }

  inflight = inflightRequests.get(key);
  if (inflight) {
    return cached ? cached.result : inflight;
  }

  const refresh = startStatusRefresh(key, options);
  return cached ? cached.result : refresh;
}
