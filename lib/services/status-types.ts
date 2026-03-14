import type { PR } from "../types.js";

export const STATUS_FIELDS = [
  "number", "headRefName", "baseRefName", "labels", "title", "author",
  "isDraft",
  "mergeStateStatus", "mergeable", "reviewDecision", "createdAt", "updatedAt",
  "autoMergeRequest",
];

export const STALE_DAYS = 7;
export const WATCH_INTERVAL_MS = 30_000;
export const STATUS_FILTER_SCOPES = ["my-stacks", "all"] as const;

export type StatusFilterScope = typeof STATUS_FILTER_SCOPES[number];

export interface PRWithStatus {
  repo: string;
  number: number;
  headRefName: string;
  baseRefName: string;
  labels: string[];
  title: string;
  author: { login: string };
  isDraft: boolean;
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

export type StatusBasePR = PR & {
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  createdAt?: string;
  updatedAt?: string;
  autoMergeRequest?: unknown;
};
