/**
 * ApiProvider — a single interface covering every external side effect in copse.
 *
 * The real implementation delegates to the existing `gh` CLI wrapper, Cursor
 * HTTP client, filesystem helpers, and git commands.
 *
 * The test implementation (`MockApiProvider`) keeps all state in memory so that
 * every feature of the app — TUI, web, and CLI — can be exercised without
 * network access or installed tooling.
 *
 * Usage:
 *   import { getProvider, setProvider, resetProvider } from "./api-provider.js";
 *   // In production the default real provider is used automatically.
 *   // In tests:
 *   import { MockApiProvider } from "./mock-api-provider.js";
 *   setProvider(new MockApiProvider());
 *   // ... run test ...
 *   resetProvider(); // restore the real provider
 */

import type { PR, WorkflowRun, PRReviewComment, PRChangedFile } from "./types.js";
import type { CommitInfo } from "./gh.js";
import type { CursorAgent, CursorArtifact } from "./cursor-api.js";
import type { Copserc } from "./config.js";

// ─── Provider interface ────────────────────────────────────────────────────

export interface ApiProvider {
  // ── GitHub: authentication & user ──
  ensureGh(): void;
  getCurrentUser(): string;

  // ── GitHub: PRs ──
  listOpenPRs(repo: string, fields: string[]): PR[];
  listOpenPRsAsync(repo: string, fields: string[]): Promise<PR[]>;

  // ── GitHub: branches ──
  listBranches(repo: string): string[];
  listBranchesAsync(repo: string): Promise<string[]>;
  getDefaultBranchAsync(repo: string): Promise<string>;

  // ── GitHub: workflow runs ──
  listWorkflowRuns(repo: string, branch: string): WorkflowRun[];
  listWorkflowRunsAsync(repo: string, branch: string): Promise<WorkflowRun[]>;

  // ── GitHub: commits ──
  getCommitInfo(repo: string, branchRef: string, includeMessage?: boolean): CommitInfo;
  getCommitInfoAsync(repo: string, branchRef: string, includeMessage?: boolean): Promise<CommitInfo>;

  // ── GitHub: PR review comments ──
  listPRReviewComments(repo: string, prNumber: number): PRReviewComment[];
  listPRReviewCommentsAsync(repo: string, prNumber: number): Promise<PRReviewComment[]>;
  getUnresolvedCommentCounts(repo: string, prNumbers: number[]): Map<number, number>;
  getUnresolvedCommentCountsAsync(repo: string, prNumbers: number[]): Promise<Map<number, number>>;

  // ── GitHub: PR mutations ──
  addPRCommentAsync(repo: string, prNumber: number, body: string): Promise<void>;
  replyToPRCommentAsync(repo: string, prNumber: number, inReplyToId: number, body: string): Promise<void>;
  listPRFiles(repo: string, prNumber: number): PRChangedFile[];
  listPRFilesAsync(repo: string, prNumber: number): Promise<PRChangedFile[]>;

  // ── GitHub: low-level gh CLI passthrough ──
  gh(...args: string[]): string;
  ghQuiet(...args: string[]): string;
  ghQuietAsync(...args: string[]): Promise<string>;

  // ── Cursor API ──
  cursorListAgentsByPrUrl(apiKey: string, prUrl: string): Promise<CursorAgent[]>;
  cursorFindLatestAgentByPrUrl(apiKey: string, prUrl: string): Promise<CursorAgent | null>;
  cursorAddFollowup(apiKey: string, agentId: string, text: string): Promise<string>;
  cursorLaunchAgentForPrUrl(apiKey: string, prUrl: string, text: string): Promise<string>;
  cursorListAgentArtifacts(apiKey: string, agentId: string): Promise<CursorArtifact[]>;
  cursorGetArtifactDownloadUrl(apiKey: string, agentId: string, absolutePath: string): Promise<{ url: string; expiresAt?: string }>;

  // ── Configuration ──
  loadConfig(cwd?: string): Copserc | null;
  getConfiguredRepos(cwd?: string): string[] | null;

  // ── Git ──
  getOriginRepo(): string | null;

  // ── Templates ──
  loadTemplates(dirPath: string): Map<string, string>;

  // ── Status caching ──
  invalidateStatusCache(): void;
}

// ─── Global provider registry ──────────────────────────────────────────────

let _provider: ApiProvider | null = null;
let _defaultProvider: ApiProvider | null = null;

/** Get the current provider. Lazily creates the real provider on first call. */
export function getProvider(): ApiProvider {
  if (_provider) return _provider;
  if (!_defaultProvider) {
    _defaultProvider = createRealProvider();
  }
  return _defaultProvider;
}

/** Replace the provider (for tests). */
export function setProvider(provider: ApiProvider): void {
  _provider = provider;
}

/** Restore the default (real) provider. */
export function resetProvider(): void {
  _provider = null;
}

// ─── Real provider (wraps existing modules) ────────────────────────────────
// All imports are dynamic so that test files importing only the mock never
// trigger `gh --version` or other side effects at module load time.

async function importReal() {
  const [ghMod, cursorApi, configMod, utilsMod, templatesMod, statusService] = await Promise.all([
    import("./gh.js"),
    import("./cursor-api.js"),
    import("./config.js"),
    import("./utils.js"),
    import("./templates.js"),
    import("./services/status-service.js"),
  ]);
  return { ghMod, cursorApi, configMod, utilsMod, templatesMod, statusService };
}

type RealModules = Awaited<ReturnType<typeof importReal>>;
let _modules: RealModules | null = null;
let _modulesPromise: Promise<RealModules> | null = null;

function getModulesSync(): RealModules {
  if (!_modules) {
    throw new Error("Real API provider modules not yet loaded. Call await ensureRealProviderLoaded() first, or use setProvider() with a mock.");
  }
  return _modules;
}

/** Pre-load real provider modules. Called once at startup in production. */
export async function ensureRealProviderLoaded(): Promise<void> {
  if (_modules) return;
  if (!_modulesPromise) {
    _modulesPromise = importReal().then((m) => { _modules = m; return m; });
  }
  await _modulesPromise;
}

function createRealProvider(): ApiProvider {
  // Eagerly kick off module loading (non-blocking).
  if (!_modules && !_modulesPromise) {
    _modulesPromise = importReal().then((m) => { _modules = m; return m; });
  }

  // Helper that gets modules — throws if not yet loaded (sync methods) or
  // awaits for async methods.
  function m(): RealModules { return getModulesSync(); }

  return {
    ensureGh: () => m().ghMod.ensureGh(),
    getCurrentUser: () => m().ghMod.getCurrentUser(),

    listOpenPRs: (repo, fields) => m().ghMod.listOpenPRs(repo, fields),
    listOpenPRsAsync: async (repo, fields) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.listOpenPRsAsync(repo, fields);
    },

    listBranches: (repo) => m().ghMod.listBranches(repo),
    listBranchesAsync: async (repo) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.listBranchesAsync(repo);
    },
    getDefaultBranchAsync: async (repo) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.getDefaultBranchAsync(repo);
    },

    listWorkflowRuns: (repo, branch) => m().ghMod.listWorkflowRuns(repo, branch),
    listWorkflowRunsAsync: async (repo, branch) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.listWorkflowRunsAsync(repo, branch);
    },

    getCommitInfo: (repo, ref, msg) => m().ghMod.getCommitInfo(repo, ref, msg),
    getCommitInfoAsync: async (repo, ref, msg) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.getCommitInfoAsync(repo, ref, msg);
    },

    listPRReviewComments: (repo, pr) => m().ghMod.listPRReviewComments(repo, pr),
    listPRReviewCommentsAsync: async (repo, pr) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.listPRReviewCommentsAsync(repo, pr);
    },
    getUnresolvedCommentCounts: (repo, nums) => m().ghMod.getUnresolvedCommentCounts(repo, nums),
    getUnresolvedCommentCountsAsync: async (repo, nums) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.getUnresolvedCommentCountsAsync(repo, nums);
    },

    addPRCommentAsync: async (repo, pr, body) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.addPRCommentAsync(repo, pr, body);
    },
    replyToPRCommentAsync: async (repo, pr, id, body) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.replyToPRCommentAsync(repo, pr, id, body);
    },
    listPRFiles: (repo, pr) => m().ghMod.listPRFiles(repo, pr),
    listPRFilesAsync: async (repo, pr) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.listPRFilesAsync(repo, pr);
    },

    gh: (...args) => m().ghMod.gh(...args),
    ghQuiet: (...args) => m().ghMod.ghQuiet(...args),
    ghQuietAsync: async (...args) => {
      if (!_modules) await _modulesPromise;
      return m().ghMod.ghQuietAsync(...args);
    },

    cursorListAgentsByPrUrl: async (key, url) => {
      if (!_modules) await _modulesPromise;
      return m().cursorApi.listAgentsByPrUrl(key, url);
    },
    cursorFindLatestAgentByPrUrl: async (key, url) => {
      if (!_modules) await _modulesPromise;
      return m().cursorApi.findLatestAgentByPrUrl(key, url);
    },
    cursorAddFollowup: async (key, id, text) => {
      if (!_modules) await _modulesPromise;
      return m().cursorApi.addFollowup(key, id, text);
    },
    cursorLaunchAgentForPrUrl: async (key, url, text) => {
      if (!_modules) await _modulesPromise;
      return m().cursorApi.launchAgentForPrUrl(key, url, text);
    },
    cursorListAgentArtifacts: async (key, id) => {
      if (!_modules) await _modulesPromise;
      return m().cursorApi.listAgentArtifacts(key, id);
    },
    cursorGetArtifactDownloadUrl: async (key, id, path) => {
      if (!_modules) await _modulesPromise;
      return m().cursorApi.getArtifactDownloadUrl(key, id, path);
    },

    loadConfig: (cwd) => m().configMod.loadConfig(cwd),
    getConfiguredRepos: (cwd) => m().configMod.getConfiguredRepos(cwd),

    getOriginRepo: () => m().utilsMod.getOriginRepo(),

    loadTemplates: (dir) => m().templatesMod.loadTemplates(dir),

    invalidateStatusCache: () => m().statusService.invalidateStatusCache(),
  };
}
