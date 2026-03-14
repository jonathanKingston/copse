import {
  getAgentForPR,
  getUnresolvedCommentCounts,
  getUnresolvedCommentCountsAsync,
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
import { filterPRs } from "../filters.js";
import type { WorkflowRun } from "../types.js";
import { STALE_DAYS, WATCH_INTERVAL_MS, STATUS_FIELDS, type PRWithStatus, type StatusBasePR } from "./status-types.js";

export interface StatusQueryOptions {
  repos: string[];
  mineOnly: boolean;
}

interface CacheEntry {
  result: PRWithStatus[];
  expiresAt: number;
}

interface SerializedCacheEntry extends CacheEntry {
  key: string;
}

const statusCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<PRWithStatus[]>>();
const STATUS_CACHE_DIR = join(tmpdir(), "copse", "status-cache");
let diskCacheDirPromise: Promise<string | null> | null = null;

function cacheKey(options: StatusQueryOptions): string {
  return `${[...options.repos].sort().join(",")}\0${options.mineOnly}`;
}

export function invalidateStatusCache(): void {
  statusCache.clear();
  inflightRequests.clear();
  void clearDiskStatusCache();
}

function sortPRs(prs: PRWithStatus[]): PRWithStatus[] {
  return prs.sort((a, b) => a.ageDays - b.ageDays);
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

async function readDiskStatusCache(key: string): Promise<CacheEntry | null> {
  const dir = await getDiskCacheDir();
  if (!dir) return null;

  try {
    const raw = await readFile(join(dir, cacheFileName(key)), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidCacheEntry(parsed) || parsed.key !== key) {
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
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

export function applyCIStatus(pr: PRWithStatus, runs: WorkflowRun[]): void {
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

function toPRWithStatus(repo: string, raw: StatusBasePR, now: number): PRWithStatus {
  const mergeStateStatus = raw.mergeStateStatus ?? "";
  const reviewDecision = raw.reviewDecision ?? "REVIEW_REQUIRED";
  const createdAt = raw.createdAt ?? "";
  const updatedAt = raw.updatedAt ?? "";
  const ageDays = createdAt
    ? Math.floor((now - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    repo,
    number: raw.number,
    headRefName: raw.headRefName,
    labels: (raw.labels || []).map((label) => label.name).filter(Boolean),
    title: raw.title ?? "",
    author: raw.author,
    isDraft: raw.isDraft === true,
    mergeStateStatus,
    mergeable: raw.mergeable ?? "UNKNOWN",
    reviewDecision,
    updatedAt,
    agent: getAgentForPR(raw),
    autoMerge: raw.autoMergeRequest != null,
    ciStatus: "pending",
    conflicts: mergeStateStatus === "HAS_CONFLICTS",
    ageDays,
    stale: ageDays >= STALE_DAYS,
    readyToMerge: false,
    commentCount: 0,
  };
}

export function fetchPRsWithStatusSync(options: StatusQueryOptions): PRWithStatus[] {
  const result: PRWithStatus[] = [];
  const now = Date.now();

  for (const repo of options.repos) {
    validateRepo(repo);
    const rawPRs = listOpenPRs(repo, STATUS_FIELDS) as StatusBasePR[];
    const matching = filterPRs(rawPRs, { repo, agent: null, mineOnly: options.mineOnly }) as StatusBasePR[];
    for (const pr of matching) {
      result.push(toPRWithStatus(repo, pr, now));
    }
  }

  const byRepo = new Map<string, PRWithStatus[]>();
  for (const pr of result) {
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
    } catch {
      // Keep the default value when comments cannot be fetched.
    }
  }

  const branchCache = new Map<string, WorkflowRun[]>();
  for (const pr of result) {
    const key = `${pr.repo}\0${pr.headRefName}`;
    let runs = branchCache.get(key);
    if (runs === undefined) {
      try {
        runs = listWorkflowRuns(pr.repo, pr.headRefName);
      } catch {
        runs = [];
      }
      branchCache.set(key, runs);
    }
    applyCIStatus(pr, runs);
  }

  return sortPRs(result);
}

async function fetchPRsWithStatusUncached(options: StatusQueryOptions): Promise<PRWithStatus[]> {
  const result: PRWithStatus[] = [];
  const now = Date.now();

  for (const repo of options.repos) {
    validateRepo(repo);
    const rawPRs = await listOpenPRsAsync(repo, STATUS_FIELDS) as StatusBasePR[];
    const matching = filterPRs(rawPRs, { repo, agent: null, mineOnly: options.mineOnly }) as StatusBasePR[];
    for (const pr of matching) {
      result.push(toPRWithStatus(repo, pr, now));
    }
  }

  const byRepo = new Map<string, PRWithStatus[]>();
  for (const pr of result) {
    const list = byRepo.get(pr.repo) ?? [];
    list.push(pr);
    byRepo.set(pr.repo, list);
  }

  for (const [repo, repoPrs] of byRepo) {
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
  for (const pr of result) {
    const key = `${pr.repo}\0${pr.headRefName}`;
    let runs = branchCache.get(key);
    if (runs === undefined) {
      try {
        runs = await listWorkflowRunsAsync(pr.repo, pr.headRefName);
      } catch {
        runs = [];
      }
      branchCache.set(key, runs);
    }
    applyCIStatus(pr, runs);
  }

  return sortPRs(result);
}

export async function fetchPRsWithStatus(options: StatusQueryOptions): Promise<PRWithStatus[]> {
  const key = cacheKey(options);

  const cached = statusCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const inflight = inflightRequests.get(key);
  if (inflight) {
    return inflight;
  }

  const diskCached = await readDiskStatusCache(key);
  if (diskCached) {
    statusCache.set(key, diskCached);
    return diskCached.result;
  }

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
