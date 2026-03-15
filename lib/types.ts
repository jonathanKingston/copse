// ---------------------------------------------------------------------------
// PR type hierarchy
// ---------------------------------------------------------------------------

/**
 * Base PR shape returned by `gh pr list`. This is the minimal contract shared
 * across every PR-related feature (filters, commands, status dashboard, web).
 */
export interface PR {
  number: number;
  headRefName: string;
  baseRefName?: string;
  labels: { name: string }[];
  title: string;
  body?: string;
  author: { login: string };
}

/**
 * Extended PR fields fetched for the status dashboard. Extends {@link PR} with
 * optional GitHub metadata that may be present depending on the query fields.
 */
export interface StatusBasePR extends PR {
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  createdAt?: string;
  updatedAt?: string;
  autoMergeRequest?: unknown;
}

/**
 * Common fields shared by every row rendered in the status dashboard
 * (both PRs and standalone agent branches).
 */
export interface StatusRowBase {
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

/**
 * A fully-enriched PR row for the status dashboard / web UI. The `labels`
 * field is flattened to `string[]` (label names only) for display purposes.
 */
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

/**
 * A standalone agent branch row (no open PR) for the status dashboard.
 */
export interface BranchWithStatus extends StatusRowBase {
  rowType: "branch";
}

/** Discriminated union of all status dashboard rows. */
export type StatusRow = PRWithStatus | BranchWithStatus;

/** Type guard that narrows a {@link StatusRow} to {@link PRWithStatus}. */
export function isPRWithStatus(row: StatusRow): row is PRWithStatus {
  return row.rowType === "pr";
}

// ---------------------------------------------------------------------------
// Other shared types
// ---------------------------------------------------------------------------

export interface AgentPatternWithLabels {
  branch: RegExp;
  labels: string[];
}

export interface WorkflowRun {
  databaseId: number;
  name: string;
  conclusion: string;
  attempt?: number;
  status: string;
  displayTitle: string;
}

export interface MergeResult {
  ok: boolean;
  alreadyUpToDate?: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ExecError {
  stderr?: string;
  output?: (string | null)[];
  message?: string;
}

export interface PRReviewComment {
  id: number;
  node_id: string;
  body: string;
  body_html?: string;
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  user: { login: string; type?: string };
  created_at: string;
  html_url: string;
  pull_request_url: string;
  in_reply_to_id?: number | null;
}

export interface PRChangedFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface CommandArg {
  name: string;
  description: string;
}

export interface CommandDef {
  file: string;
  description: string;
  usage: string;
  args: CommandArg[];
}
