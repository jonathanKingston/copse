// Re-export the canonical PR status types from the shared type hierarchy.
export type {
  StatusBasePR,
  StatusRowBase,
  PRWithStatus,
  BranchWithStatus,
  StatusRow,
} from "../types.js";
export { isPRWithStatus } from "../types.js";

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
