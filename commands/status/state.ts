/**
 * State management types, constants, and helpers for the status dashboard.
 */

import { execFile as execFileCb } from "child_process";
import type { PRReviewComment, PRChangedFile } from "../../lib/types.js";
import type { CursorArtifact } from "../../lib/cursor-api.js";
import { STALE_DAYS, type PRWithStatus } from "../../lib/services/status-types.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const BULK_COOLDOWN_MS = 2_000;
export const FIXED_COLS_WIDTH = 39;
export const REPO_COL_WIDTH = 19;

export const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  amber: "\x1b[33m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

// ── Types ──────────────────────────────────────────────────────────────────

export type Urgency = "red" | "amber" | "green";

export type VirtualRow =
  | { kind: "pr"; prIndex: number }
  | { kind: "comment"; prIndex: number; commentIndex: number }
  | { kind: "comment-body"; prIndex: number; commentIndex: number; line: string }
  | { kind: "diff-file"; prIndex: number; fileIndex: number }
  | { kind: "artifact"; prIndex: number; artifactIndex: number }
  | { kind: "info"; prIndex: number; text: string };

export type CommentTarget =
  | { kind: "pr"; pr: PRWithStatus }
  | { kind: "comment"; pr: PRWithStatus; comment: PRReviewComment }
  | { kind: "batch"; pr: PRWithStatus; comments: PRReviewComment[] }
  | null;

/**
 * Shared mutable state for the TUI dashboard.
 * Encapsulates all the variables that were previously closure-scoped in runWatch.
 */
export interface DashboardState {
  repos: string[];
  singleRepo: boolean;
  mineOnlyFilter: boolean;
  currentPRs: PRWithStatus[];
  statusMsg: string;
  busy: boolean;
  selectedIndex: number;
  ciGeneration: number;
  ciUpdatePending: boolean;
  isTTY: boolean;

  virtualRows: VirtualRow[];
  expandedPRIndex: number | null;
  expandedPRNumber: number | null;
  expandedComments: PRReviewComment[];
  expandedFiles: PRChangedFile[];
  expandedArtifacts: CursorArtifact[];
  expandedCursorAgentId: string | null;
  expandedLoading: boolean;
  expandedMode: "comments" | "diff" | "artifacts";
  readonly DETAIL_MAX_LINES: number;

  commentInputMode: boolean;
  templatePickerMode: boolean;
  commentBuffer: string;
  commentTarget: CommentTarget;
  readonly selectedCommentIndices: Set<number>;

  searchMode: boolean;
  searchBuffer: string;
  searchQuery: string;
  preSearchQuery: string;
  scrollOffset: number;

  issueCreateMode: boolean;
  issueCreateStep: "title" | "body" | "template";
  issueTitleBuffer: string;
  issueBodyBuffer: string;
  issueTemplateChoice: number;
  issueTargetRepo: string | null;

  readonly templateLabels: string[];
  readonly templatesMap: Map<string, string>;
  cursorApiKey: string | null;

  readonly ROW_START: number;
  readonly TITLE: string;
}

export function createDashboardState(opts: {
  repos: string[];
  mineOnly: boolean;
  templatesMap: Map<string, string>;
  cursorApiKey: string | null;
}): DashboardState {
  return {
    repos: opts.repos,
    singleRepo: opts.repos.length === 1,
    mineOnlyFilter: opts.mineOnly,
    currentPRs: [],
    statusMsg: "",
    busy: false,
    selectedIndex: 0,
    ciGeneration: 0,
    ciUpdatePending: false,
    isTTY: !!process.stdin.isTTY,

    virtualRows: [],
    expandedPRIndex: null,
    expandedPRNumber: null,
    expandedComments: [],
    expandedFiles: [],
    expandedArtifacts: [],
    expandedCursorAgentId: null,
    expandedLoading: false,
    expandedMode: "comments",
    DETAIL_MAX_LINES: 10,

    commentInputMode: false,
    templatePickerMode: false,
    commentBuffer: "",
    commentTarget: null,
    selectedCommentIndices: new Set<number>(),

    searchMode: false,
    searchBuffer: "",
    searchQuery: "",
    preSearchQuery: "",
    scrollOffset: 0,

    issueCreateMode: false,
    issueCreateStep: "title",
    issueTitleBuffer: "",
    issueBodyBuffer: "",
    issueTemplateChoice: -1,
    issueTargetRepo: null,

    templateLabels: Array.from(opts.templatesMap.keys()),
    templatesMap: opts.templatesMap,
    cursorApiKey: opts.cursorApiKey,

    ROW_START: 5,
    TITLE: "copse status",
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

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

export function execAsync(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(command, args, { encoding: "utf-8", timeout: 30_000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout);
    });
  });
}

// ── State mutation helpers ─────────────────────────────────────────────────

export function getViewportHeight(state: DashboardState): number {
  const termRows = process.stdout.rows || 24;
  return Math.max(1, termRows - state.ROW_START - 2);
}

export function ensureVisible(state: DashboardState): void {
  const vh = getViewportHeight(state);
  if (state.selectedIndex < state.scrollOffset) {
    state.scrollOffset = state.selectedIndex;
  } else if (state.selectedIndex >= state.scrollOffset + vh) {
    state.scrollOffset = state.selectedIndex - vh + 1;
  }
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, Math.max(0, state.virtualRows.length - vh)));
}

export function clampSelection(state: DashboardState): void {
  if (state.virtualRows.length === 0) {
    state.selectedIndex = 0;
    state.scrollOffset = 0;
  } else {
    state.selectedIndex = Math.min(state.selectedIndex, state.virtualRows.length - 1);
  }
  ensureVisible(state);
}

export function selectedPR(state: DashboardState): PRWithStatus | null {
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr) return null;
  return state.currentPRs[vr.prIndex] ?? null;
}

export function cleanup(state: DashboardState): void {
  if (state.isTTY) try { process.stdin.setRawMode(false); } catch {}
  process.stdout.write("\x1b[?25h\n");
  process.exit(0);
}
