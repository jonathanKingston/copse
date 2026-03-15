/**
 * Pure helper functions extracted from commands/status.ts for testability.
 */
import type { PRWithStatus } from "./services/status-types.js";
import type { PRChangedFile } from "./types.js";
import { STALE_DAYS } from "./services/status-types.js";

export type Urgency = "red" | "amber" | "green";

export function getUrgency(pr: PRWithStatus): Urgency {
  if (pr.ciStatus === "fail" || pr.conflicts) return "red";
  if (pr.stale || pr.reviewDecision === "CHANGES_REQUESTED" || pr.ciStatus === "pending") return "amber";
  return "green";
}

export function matchesSearch(pr: PRWithStatus, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const searchable = [
    pr.repo,
    String(pr.number),
    pr.agent ?? "",
    pr.ciStatus,
    pr.reviewDecision.toLowerCase().replace(/_/g, " "),
    pr.conflicts ? "conflicts" : "",
    pr.autoMerge ? "merge when ready" : "",
    `${pr.ageDays}d`,
    pr.title,
    pr.author.login,
    pr.headRefName,
  ];
  return searchable.some(f => f.toLowerCase().includes(q));
}

export const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  amber: "\x1b[33m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

export function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "").length;
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function truncatePlain(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return "\u2026";
  return text.slice(0, maxLen - 1) + "\u2026";
}

export function formatCI(pr: PRWithStatus): string {
  if (pr.ciStatus === "pass") return `${ANSI.green}\u2713${ANSI.reset}`;
  if (pr.ciStatus === "fail") return `${ANSI.red}\u2717${ANSI.reset}`;
  if (pr.ciStatus === "pending") return `${ANSI.amber}\u2026${ANSI.reset}`;
  return `${ANSI.dim}\u2014${ANSI.reset}`;
}

export function formatReview(pr: PRWithStatus): string {
  const r = pr.reviewDecision;
  if (r === "APPROVED") return `${ANSI.green}\u2713${ANSI.reset}`;
  if (r === "CHANGES_REQUESTED") return `${ANSI.amber}!${ANSI.reset}`;
  return `${ANSI.dim}\u25CB${ANSI.reset}`;
}

export function formatAutoMerge(pr: PRWithStatus): string {
  return pr.autoMerge ? `${ANSI.green}\u2713${ANSI.reset}` : `${ANSI.dim}\u2014${ANSI.reset}`;
}

export function formatComments(pr: PRWithStatus): string {
  if (pr.commentCount === 0) return `${ANSI.dim}\u2014${ANSI.reset}`;
  return `${ANSI.amber}${pr.commentCount}${ANSI.reset}`;
}

export function formatDiffFileRow(file: PRChangedFile): string {
  const statusChar = file.status === "added" ? "A" : file.status === "removed" ? "D" : file.status === "renamed" ? "R" : "M";
  const statusColor = file.status === "added" ? ANSI.green : file.status === "removed" ? ANSI.red : ANSI.amber;
  const filename = file.status === "renamed" && file.previous_filename
    ? `${file.previous_filename} \u2192 ${file.filename}`
    : file.filename;
  return `    ${statusColor}${statusChar}${ANSI.reset} ${filename} ${ANSI.green}+${file.additions}${ANSI.reset} ${ANSI.red}-${file.deletions}${ANSI.reset}`;
}

export function highlightRow(row: string): string {
  return `\x1b[7m${row.replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m")}\x1b[0m`;
}

export const FIXED_COLS_WIDTH = 39;
export const REPO_COL_WIDTH = 19;
