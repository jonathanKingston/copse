import type { PR } from "../types.js";

export const STATUS_FIELDS = [
  "number", "headRefName", "baseRefName", "labels", "title", "author",
  "isDraft",
  "mergeStateStatus", "mergeable", "reviewDecision", "createdAt", "updatedAt",
  "autoMergeRequest",
];

export const STALE_DAYS = 7;
export const WATCH_INTERVAL_MS = 60_000;
export const STATUS_FILTER_SCOPES = ["my-stacks", "all"] as const;

export type StatusFilterScope = typeof STATUS_FILTER_SCOPES[number];

interface StatusRowBase {
  rowType: "pr" | "branch";
  repo: string;
  headRefName: string;
  title: string;
  author: { login: string };
  updatedAt: string;
  agent: string | null;
  ciStatus: "pass" | "fail" | "pending" | "none";
  ageDays: number;
  stale: boolean;
}

export interface PRWithStatus extends StatusRowBase {
  rowType: "pr";
  number: number;
  baseRefName: string;
  labels: string[];
  isDraft: boolean;
  mergeStateStatus: string;
  mergeable: string;
  reviewDecision: string;
  autoMerge: boolean;
  conflicts: boolean;
  readyToMerge: boolean;
  commentCount: number;
}

export interface BranchWithStatus extends StatusRowBase {
  rowType: "branch";
}

export type StatusRow = PRWithStatus | BranchWithStatus;

export function isPRWithStatus(row: StatusRow): row is PRWithStatus {
  return row.rowType === "pr";
}

export type StatusBasePR = PR & {
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  createdAt?: string;
  updatedAt?: string;
  autoMergeRequest?: unknown;
};
