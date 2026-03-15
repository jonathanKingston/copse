import type { PR, WorkflowRun, PRReviewComment, PRChangedFile } from "./types.js";
import type { CursorAgent, CursorArtifact } from "./cursor-api.js";
import type { Copserc } from "./config.js";

export interface CommitInfoLike {
  message?: string;
  date: Date | null;
  authorLogin: string;
}

export interface ApiProvider {
  ensureGh?(): void;
  getCurrentUser?(): string;

  gh?(...args: string[]): string;
  ghQuiet?(...args: string[]): string;
  ghQuietAsync?(...args: string[]): Promise<string>;

  listOpenPRs?(repo: string, fields: string[]): PR[];
  listOpenPRsAsync?(repo: string, fields: string[]): Promise<PR[]>;
  listWorkflowRuns?(repo: string, branch: string): WorkflowRun[];
  listWorkflowRunsAsync?(repo: string, branch: string): Promise<WorkflowRun[]>;
  listBranches?(repo: string): string[];
  listBranchesAsync?(repo: string): Promise<string[]>;
  getDefaultBranchAsync?(repo: string): Promise<string>;
  getCommitInfo?(repo: string, branchRef: string, includeMessage?: boolean): CommitInfoLike;
  getCommitInfoAsync?(repo: string, branchRef: string, includeMessage?: boolean): Promise<CommitInfoLike>;
  listPRReviewComments?(repo: string, prNumber: number): PRReviewComment[];
  listPRReviewCommentsAsync?(repo: string, prNumber: number): Promise<PRReviewComment[]>;
  getUnresolvedCommentCounts?(repo: string, prNumbers: number[]): Map<number, number>;
  getUnresolvedCommentCountsAsync?(repo: string, prNumbers: number[]): Promise<Map<number, number>>;
  addPRCommentAsync?(repo: string, prNumber: number, body: string): Promise<void>;
  replyToPRCommentAsync?(repo: string, prNumber: number, inReplyToId: number, body: string): Promise<void>;
  listPRFiles?(repo: string, prNumber: number): PRChangedFile[];
  listPRFilesAsync?(repo: string, prNumber: number): Promise<PRChangedFile[]>;

  cursorListAgentsByPrUrl?(apiKey: string, prUrl: string): Promise<CursorAgent[]>;
  cursorFindLatestAgentByPrUrl?(apiKey: string, prUrl: string): Promise<CursorAgent | null>;
  cursorAddFollowup?(apiKey: string, agentId: string, text: string): Promise<string>;
  cursorLaunchAgentForPrUrl?(apiKey: string, prUrl: string, text: string): Promise<string>;
  cursorListAgentArtifacts?(apiKey: string, agentId: string): Promise<CursorArtifact[]>;
  cursorGetArtifactDownloadUrl?(
    apiKey: string,
    agentId: string,
    absolutePath: string
  ): Promise<{ url: string; expiresAt?: string }>;

  loadConfig?(cwd?: string): Copserc | null;
  getConfiguredRepos?(cwd?: string): string[] | null;
  getOriginRepo?(): string | null;
  loadTemplates?(dirPath: string): Map<string, string>;

  invalidateStatusCache?(): void;
}

let activeApiProvider: ApiProvider | null = null;

export function setApiProvider(provider: ApiProvider): void {
  activeApiProvider = provider;
}

export function getApiProvider(): ApiProvider | null {
  return activeApiProvider;
}

export function resetApiProvider(): void {
  activeApiProvider = null;
}
