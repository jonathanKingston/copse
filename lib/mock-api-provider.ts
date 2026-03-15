/**
 * MockApiProvider — a fully stateful in-memory backend for copse.
 *
 * Every piece of state that a real GitHub/Cursor/filesystem interaction would
 * touch is modelled here: repos, branches, PRs, workflow runs, review
 * comments, Cursor agents, config, and templates. The state is plain data
 * structures that tests can inspect, mutate, and reset cheaply.
 */

import type { ApiProvider } from "./api-provider.js";
import type { PR, WorkflowRun, PRReviewComment, PRChangedFile } from "./types.js";
import type { CommitInfo } from "./gh.js";
import type { CursorAgent, CursorArtifact } from "./cursor-api.js";
import type { ClaudeAgent, ClaudeArtifact } from "./claude-api.js";
import type { Copserc } from "./config.js";

export interface MockRepo {
  defaultBranch: string;
  allowSquashMerge?: boolean;
  allowMergeCommit?: boolean;
  allowRebaseMerge?: boolean;
}

export interface MockPR extends PR {
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  createdAt?: string;
  updatedAt?: string;
  autoMergeRequest?: unknown;
  state?: "open" | "closed" | "merged";
}

export interface MockReviewThread {
  id: string;
  isResolved: boolean;
  commentNodeIds: string[];
}

export class MockApiProvider implements ApiProvider {
  currentUser = "test-user";
  originRepo: string | null = null;
  config: Copserc | null = null;
  templates = new Map<string, Map<string, string>>();
  repos = new Map<string, MockRepo>();
  branches = new Map<string, string[]>();
  prs = new Map<string, MockPR[]>();
  workflowRuns = new Map<string, WorkflowRun[]>();
  commits = new Map<string, CommitInfo>();
  reviewComments = new Map<string, PRReviewComment[]>();
  reviewThreads = new Map<string, MockReviewThread[]>();
  prComments = new Map<string, string[]>();
  prReplies = new Map<string, string[]>();
  prFiles = new Map<string, PRChangedFile[]>();
  cursorAgents = new Map<string, CursorAgent[]>();
  cursorArtifacts = new Map<string, CursorArtifact[]>();
  cursorDownloadUrls = new Map<string, { url: string; expiresAt?: string }>();
  cursorFollowups = new Map<string, string[]>();
  cursorLaunches = new Map<string, string[]>();
  claudeAgents = new Map<string, ClaudeAgent[]>();
  claudeArtifacts = new Map<string, ClaudeArtifact[]>();
  claudeDownloadUrls = new Map<string, { url: string; expiresAt?: string }>();
  claudeFollowups = new Map<string, string[]>();
  claudeLaunches = new Map<string, string[]>();
  ghCalls: string[][] = [];
  private _nextAgentId = 1;
  private _nextPRNumber = 1;
  private _nextIssueNumber = 1000;
  private _nextCommentId = 5000;
  statusCacheInvalidations = 0;

  addRepo(repo: string, options: Partial<MockRepo> = {}): void {
    this.repos.set(repo, {
      defaultBranch: options.defaultBranch ?? "main",
      allowSquashMerge: options.allowSquashMerge ?? true,
      allowMergeCommit: options.allowMergeCommit ?? true,
      allowRebaseMerge: options.allowRebaseMerge ?? true,
    });
    if (!this.branches.has(repo)) this.branches.set(repo, []);
    if (!this.prs.has(repo)) this.prs.set(repo, []);
  }

  addBranch(repo: string, branchName: string, commitInfo?: Partial<CommitInfo>): void {
    const existing = this.branches.get(repo) ?? [];
    if (!existing.includes(branchName)) {
      existing.push(branchName);
      this.branches.set(repo, existing);
    }
    if (commitInfo || !this.commits.has(`${repo}:${branchName}`)) {
      this.commits.set(`${repo}:${branchName}`, {
        message: commitInfo?.message ?? `commit on ${branchName}`,
        date: commitInfo?.date ?? new Date(),
        authorLogin: commitInfo?.authorLogin ?? this.currentUser,
      });
    }
  }

  addPR(repo: string, pr: Partial<MockPR> & { headRefName: string }): MockPR {
    const list = this.prs.get(repo) ?? [];
    const number = pr.number ?? this._nextPRNumber++;
    const now = new Date().toISOString();
    const full: MockPR = {
      number,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName ?? this.repos.get(repo)?.defaultBranch ?? "main",
      labels: pr.labels ?? [],
      title: pr.title ?? `PR #${number}`,
      author: pr.author ?? { login: this.currentUser },
      isDraft: pr.isDraft ?? false,
      mergeStateStatus: pr.mergeStateStatus ?? "CLEAN",
      mergeable: pr.mergeable ?? "MERGEABLE",
      reviewDecision: pr.reviewDecision ?? "APPROVED",
      createdAt: pr.createdAt ?? now,
      updatedAt: pr.updatedAt ?? now,
      autoMergeRequest: pr.autoMergeRequest ?? null,
      state: pr.state ?? "open",
    };
    list.push(full);
    this.prs.set(repo, list);
    this.addBranch(repo, pr.headRefName);
    return full;
  }

  addWorkflowRun(repo: string, branch: string, run: Partial<WorkflowRun> & { name: string }): void {
    const key = `${repo}:${branch}`;
    const list = this.workflowRuns.get(key) ?? [];
    list.push({
      databaseId: run.databaseId ?? list.length + 1,
      name: run.name,
      conclusion: run.conclusion ?? "success",
      status: run.status ?? "completed",
      displayTitle: run.displayTitle ?? run.name,
      attempt: run.attempt ?? 1,
    });
    this.workflowRuns.set(key, list);
  }

  addReviewComment(repo: string, prNumber: number, comment: Partial<PRReviewComment> & { body: string }): PRReviewComment {
    const key = `${repo}:${prNumber}`;
    const list = this.reviewComments.get(key) ?? [];
    const id = comment.id ?? this._nextCommentId++;
    const full: PRReviewComment = {
      id,
      node_id: comment.node_id ?? `MDI_${id}`,
      body: comment.body,
      path: comment.path ?? "file.ts",
      line: comment.line ?? 1,
      original_line: comment.original_line ?? 1,
      diff_hunk: comment.diff_hunk ?? "@@ -1,3 +1,3 @@",
      user: comment.user ?? { login: "reviewer" },
      created_at: comment.created_at ?? new Date().toISOString(),
      html_url: comment.html_url ?? `https://github.com/${repo}/pull/${prNumber}#discussion_r${id}`,
      pull_request_url: comment.pull_request_url ?? `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
      in_reply_to_id: comment.in_reply_to_id,
    };
    list.push(full);
    this.reviewComments.set(key, list);
    return full;
  }

  addCursorAgent(prUrl: string, agent: Partial<CursorAgent> = {}): CursorAgent {
    const list = this.cursorAgents.get(prUrl) ?? [];
    const full: CursorAgent = {
      id: agent.id ?? `agent-${this._nextAgentId++}`,
      status: agent.status ?? "completed",
      createdAt: agent.createdAt ?? new Date().toISOString(),
      target: agent.target ?? { prUrl },
    };
    list.push(full);
    this.cursorAgents.set(prUrl, list);
    return full;
  }

  addClaudeAgent(prUrl: string, agent: Partial<ClaudeAgent> = {}): ClaudeAgent {
    const list = this.claudeAgents.get(prUrl) ?? [];
    const full: ClaudeAgent = {
      id: agent.id ?? `claude-agent-${this._nextAgentId++}`,
      status: agent.status ?? "completed",
      createdAt: agent.createdAt ?? new Date().toISOString(),
      target: agent.target ?? { prUrl },
    };
    list.push(full);
    this.claudeAgents.set(prUrl, list);
    return full;
  }

  reset(): void {
    this.currentUser = "test-user";
    this.originRepo = null;
    this.config = null;
    this.templates.clear();
    this.repos.clear();
    this.branches.clear();
    this.prs.clear();
    this.workflowRuns.clear();
    this.commits.clear();
    this.reviewComments.clear();
    this.reviewThreads.clear();
    this.prComments.clear();
    this.prReplies.clear();
    this.prFiles.clear();
    this.cursorAgents.clear();
    this.cursorArtifacts.clear();
    this.cursorDownloadUrls.clear();
    this.cursorFollowups.clear();
    this.cursorLaunches.clear();
    this.claudeAgents.clear();
    this.claudeArtifacts.clear();
    this.claudeDownloadUrls.clear();
    this.claudeFollowups.clear();
    this.claudeLaunches.clear();
    this.ghCalls = [];
    this._nextAgentId = 1;
    this._nextPRNumber = 1;
    this._nextIssueNumber = 1000;
    this._nextCommentId = 5000;
    this.statusCacheInvalidations = 0;
  }

  ensureGh(): void {}

  getCurrentUser(): string {
    return this.currentUser;
  }

  listOpenPRs(repo: string, _fields: string[] = []): PR[] {
    return (this.prs.get(repo) ?? []).filter((pr) => (pr.state ?? "open") === "open");
  }

  async listOpenPRsAsync(repo: string, _fields: string[] = []): Promise<PR[]> {
    return this.listOpenPRs(repo);
  }

  listBranches(repo: string): string[] {
    return this.branches.get(repo) ?? [];
  }

  async listBranchesAsync(repo: string): Promise<string[]> {
    return this.listBranches(repo);
  }

  async getDefaultBranchAsync(repo: string): Promise<string> {
    const r = this.repos.get(repo);
    if (!r) throw new Error(`Mock: unknown repo "${repo}"`);
    return r.defaultBranch;
  }

  listWorkflowRuns(repo: string, branch: string): WorkflowRun[] {
    return this.workflowRuns.get(`${repo}:${branch}`) ?? [];
  }

  async listWorkflowRunsAsync(repo: string, branch: string): Promise<WorkflowRun[]> {
    return this.listWorkflowRuns(repo, branch);
  }

  getCommitInfo(repo: string, branchRef: string, includeMessage?: boolean): CommitInfo {
    const info = this.commits.get(`${repo}:${branchRef}`);
    if (!info) {
      return {
        message: includeMessage ? branchRef : undefined,
        date: new Date(),
        authorLogin: this.currentUser,
      };
    }
    return includeMessage ? info : { date: info.date, authorLogin: info.authorLogin };
  }

  async getCommitInfoAsync(repo: string, branchRef: string, includeMessage?: boolean): Promise<CommitInfo> {
    return this.getCommitInfo(repo, branchRef, includeMessage);
  }

  listPRReviewComments(repo: string, prNumber: number): PRReviewComment[] {
    const all = this.reviewComments.get(`${repo}:${prNumber}`) ?? [];
    const threads = this.reviewThreads.get(`${repo}:${prNumber}`) ?? [];
    const resolvedNodeIds = new Set<string>();
    for (const t of threads) {
      if (t.isResolved) {
        for (const id of t.commentNodeIds) resolvedNodeIds.add(id);
      }
    }
    return all.filter((c) => !resolvedNodeIds.has(c.node_id));
  }

  async listPRReviewCommentsAsync(repo: string, prNumber: number): Promise<PRReviewComment[]> {
    return this.listPRReviewComments(repo, prNumber);
  }

  getUnresolvedCommentCounts(repo: string, prNumbers: number[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (const num of prNumbers) {
      const comments = this.listPRReviewComments(repo, num);
      counts.set(num, comments.length);
    }
    return counts;
  }

  async getUnresolvedCommentCountsAsync(repo: string, prNumbers: number[]): Promise<Map<number, number>> {
    return this.getUnresolvedCommentCounts(repo, prNumbers);
  }

  async addPRCommentAsync(repo: string, prNumber: number, body: string): Promise<void> {
    const key = `${repo}:${prNumber}`;
    const list = this.prComments.get(key) ?? [];
    list.push(body);
    this.prComments.set(key, list);
  }

  async replyToPRCommentAsync(repo: string, prNumber: number, inReplyToId: number, body: string): Promise<void> {
    const key = `${repo}:${prNumber}:${inReplyToId}`;
    const list = this.prReplies.get(key) ?? [];
    list.push(body);
    this.prReplies.set(key, list);
  }

  listPRFiles(repo: string, prNumber: number): PRChangedFile[] {
    return this.prFiles.get(`${repo}:${prNumber}`) ?? [];
  }

  async listPRFilesAsync(repo: string, prNumber: number): Promise<PRChangedFile[]> {
    return this.listPRFiles(repo, prNumber);
  }

  gh(...args: string[]): string {
    return this._handleGhCall(args);
  }

  ghQuiet(...args: string[]): string {
    return this._handleGhCall(args);
  }

  async ghQuietAsync(...args: string[]): Promise<string> {
    return this._handleGhCall(args);
  }

  private _handleGhCall(args: string[]): string {
    this.ghCalls.push([...args]);

    if (args[0] === "pr" && args[1] === "view") return this._handlePrView(args);
    if (args[0] === "pr" && args[1] === "edit") return this._handlePrEdit(args);
    if (args[0] === "pr" && args[1] === "merge") return this._handlePrMerge(args);
    if (args[0] === "pr" && args[1] === "ready") return this._handlePrReady(args);
    if (args[0] === "pr" && args[1] === "review") return this._handlePrReview(args);
    if (args[0] === "pr" && args[1] === "close") return this._handlePrClose(args);
    if (args[0] === "pr" && args[1] === "comment") return this._handlePrComment(args);
    if (args[0] === "pr" && args[1] === "create") return this._handlePrCreate(args);
    if (args[0] === "pr" && args[1] === "list") return this._handlePrList(args);
    if (args[0] === "run" && args[1] === "list") return this._handleRunList(args);
    if (args[0] === "run" && args[1] === "rerun") return this._handleRunRerun(args);
    if (args[0] === "issue" && args[1] === "create") return this._handleIssueCreate(args);
    if (args[0] === "issue" && args[1] === "comment") return "";
    if (args[0] === "api" && args[1]?.startsWith("repos/")) return this._handleApiRepos(args);
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: this.currentUser });
    if (args[0] === "api" && args[1] === "graphql") return this._handleApiGraphql(args);

    return "";
  }

  private _findFlag(args: string[], flag: string): string | null {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  private _findRepo(args: string[]): string | null {
    return this._findFlag(args, "--repo");
  }

  private _findPR(repo: string, prNumberStr: string): MockPR | undefined {
    const num = parseInt(prNumberStr, 10);
    return (this.prs.get(repo) ?? []).find((p) => p.number === num);
  }

  private _handlePrView(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const prNumStr = args[2] ?? "";
    const pr = this._findPR(repo, prNumStr);
    if (!pr) return "";

    const jsonFlag = this._findFlag(args, "--json");
    const jqFlag = this._findFlag(args, "-q");
    if (jsonFlag === "isDraft" && jqFlag === ".isDraft") return `${pr.isDraft ?? false}\n`;
    if (jsonFlag === "baseRefName" && jqFlag === ".baseRefName") return `${pr.baseRefName ?? "main"}\n`;
    return JSON.stringify(pr);
  }

  private _handlePrEdit(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const prNumStr = args[2] ?? "";
    const pr = this._findPR(repo, prNumStr);
    if (!pr) throw this._ghError(`PR ${prNumStr} not found in ${repo}`);

    const newBase = this._findFlag(args, "--base");
    if (newBase) pr.baseRefName = newBase;
    return "";
  }

  private _handlePrMerge(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const prNumStr = args.find((a, i) => i >= 2 && /^\d+$/.test(a)) ?? "";
    const pr = this._findPR(repo, prNumStr);
    if (!pr) throw this._ghError(`PR ${prNumStr} not found in ${repo}`);
    if (args.includes("--auto")) {
      pr.autoMergeRequest = { enabledAt: new Date().toISOString() };
    } else {
      pr.state = "merged";
    }
    return "";
  }

  private _handlePrReady(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const prNumStr = args[2] ?? "";
    const pr = this._findPR(repo, prNumStr);
    if (pr) pr.isDraft = false;
    return "";
  }

  private _handlePrReview(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const prNumStr = args.find((a, i) => i >= 2 && /^\d+$/.test(a)) ?? "";
    const pr = this._findPR(repo, prNumStr);
    if (pr && args.includes("--approve")) pr.reviewDecision = "APPROVED";
    return "";
  }

  private _handlePrClose(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const prNumStr = args[2] ?? "";
    const pr = this._findPR(repo, prNumStr);
    if (pr) pr.state = "closed";
    return "";
  }

  private _handlePrComment(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const prNumStr = args[2] ?? "";
    const body = this._findFlag(args, "--body") ?? "";
    const key = `${repo}:${prNumStr}`;
    const list = this.prComments.get(key) ?? [];
    list.push(body);
    this.prComments.set(key, list);
    return "";
  }

  private _handlePrCreate(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const head = this._findFlag(args, "--head") ?? "";
    const base = this._findFlag(args, "--base") ?? "main";
    const title = this._findFlag(args, "--title") ?? head;
    const body = this._findFlag(args, "--body");
    const num = this._nextPRNumber++;
    const pr: MockPR = {
      number: num,
      headRefName: head,
      baseRefName: base,
      labels: [],
      title,
      body: body ?? undefined,
      author: { login: this.currentUser },
      state: "open",
    };
    const list = this.prs.get(repo) ?? [];
    list.push(pr);
    this.prs.set(repo, list);
    return `https://github.com/${repo}/pull/${num}\n`;
  }

  private _handlePrList(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const openPRs = (this.prs.get(repo) ?? []).filter((p) => (p.state ?? "open") === "open");
    return JSON.stringify(openPRs);
  }

  private _handleRunList(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const branch = this._findFlag(args, "--branch") ?? "";
    const runs = this.workflowRuns.get(`${repo}:${branch}`) ?? [];
    return JSON.stringify(runs);
  }

  private _handleRunRerun(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const runId = parseInt(args[2] ?? "", 10);
    for (const [key, runs] of this.workflowRuns) {
      if (!key.startsWith(`${repo}:`)) continue;
      const run = runs.find((r) => r.databaseId === runId);
      if (run) {
        run.conclusion = "";
        run.status = "queued";
        break;
      }
    }
    return "";
  }

  private _handleIssueCreate(args: string[]): string {
    const repo = this._findRepo(args) ?? "";
    const num = this._nextIssueNumber++;
    return `https://github.com/${repo}/issues/${num}\n`;
  }

  private _handleApiRepos(args: string[]): string {
    const path = args[1] ?? "";
    const repoMatch = path.match(/^repos\/([^/]+\/[^/]+)$/);
    if (repoMatch) {
      const repo = repoMatch[1];
      const r = this.repos.get(repo);
      if (!r) return JSON.stringify({});

      const jqFlag = this._findFlag(args, "-q");
      if (jqFlag === ".default_branch") return `${r.defaultBranch}\n`;
      if (jqFlag?.includes("allowSquashMerge")) {
        return JSON.stringify({
          allowSquashMerge: r.allowSquashMerge ?? true,
          allowMergeCommit: r.allowMergeCommit ?? true,
          allowRebaseMerge: r.allowRebaseMerge ?? true,
        });
      }
      return JSON.stringify({
        default_branch: r.defaultBranch,
        allow_squash_merge: r.allowSquashMerge ?? true,
        allow_merge_commit: r.allowMergeCommit ?? true,
        allow_rebase_merge: r.allowRebaseMerge ?? true,
      });
    }

    const branchesMatch = path.match(/^repos\/([^/]+\/[^/]+)\/branches$/);
    if (branchesMatch) {
      const repo = branchesMatch[1];
      return `${(this.branches.get(repo) ?? []).join("\n")}\n`;
    }

    const commitMatch = path.match(/^repos\/([^/]+\/[^/]+)\/commits\/(.+)$/);
    if (commitMatch) {
      const repo = commitMatch[1];
      const ref = decodeURIComponent(commitMatch[2]);
      const info = this.commits.get(`${repo}:${ref}`);
      if (info) {
        return JSON.stringify({
          commit: {
            message: info.message ?? "",
            author: { date: info.date?.toISOString() ?? "" },
          },
          author: { login: info.authorLogin },
        });
      }
      return JSON.stringify({ commit: { message: "", author: { date: "" } }, author: { login: "" } });
    }

    const commentsMatch = path.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments$/);
    if (commentsMatch) {
      const repo = commentsMatch[1];
      const prNumber = parseInt(commentsMatch[2], 10);
      return JSON.stringify(this.listPRReviewComments(repo, prNumber));
    }

    const filesMatch = path.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/);
    if (filesMatch) {
      const repo = filesMatch[1];
      const prNumber = parseInt(filesMatch[2], 10);
      return JSON.stringify(this.prFiles.get(`${repo}:${prNumber}`) ?? []);
    }

    const replyMatch = path.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments\/(\d+)\/replies$/);
    if (replyMatch) {
      const repo = replyMatch[1];
      const prNumber = parseInt(replyMatch[2], 10);
      const inReplyToId = parseInt(replyMatch[3], 10);
      const bodyRaw = this._findFlag(args, "-f") ?? "";
      const body = bodyRaw.startsWith("body=") ? bodyRaw.slice("body=".length) : bodyRaw;
      const key = `${repo}:${prNumber}:${inReplyToId}`;
      const list = this.prReplies.get(key) ?? [];
      list.push(body);
      this.prReplies.set(key, list);
      return "";
    }

    const mergesMatch = path.match(/^repos\/([^/]+\/[^/]+)\/merges$/);
    if (mergesMatch) {
      return JSON.stringify({ sha: "mock-merge-sha" });
    }

    return "";
  }

  private _handleApiGraphql(args: string[]): string {
    const queryArg = args.find((a, i) => i > 0 && args[i - 1] === "-f" && a.startsWith("query="));
    const query = queryArg?.slice("query=".length) ?? "";

    if (query.includes("reviewThreads")) {
      return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      });
    }
    if (query.includes("commits(last:") || query.includes("commits(last :")) {
      return JSON.stringify({ data: { repository: {} } });
    }

    return JSON.stringify({ data: {} });
  }

  private _ghError(message: string): Error {
    const err = new Error(message) as Error & { stderr?: string };
    err.stderr = message;
    return err;
  }

  async cursorListAgentsByPrUrl(_apiKey: string, prUrl: string): Promise<CursorAgent[]> {
    return this.cursorAgents.get(prUrl) ?? [];
  }

  async cursorFindLatestAgentByPrUrl(_apiKey: string, prUrl: string): Promise<CursorAgent | null> {
    const agents = this.cursorAgents.get(prUrl) ?? [];
    if (agents.length === 0) return null;
    const sorted = [...agents].sort((a, b) => {
      const aTs = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTs = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bTs - aTs;
    });
    return sorted[0] ?? null;
  }

  async cursorAddFollowup(_apiKey: string, agentId: string, text: string): Promise<string> {
    const list = this.cursorFollowups.get(agentId) ?? [];
    list.push(text);
    this.cursorFollowups.set(agentId, list);
    return agentId;
  }

  async cursorLaunchAgentForPrUrl(_apiKey: string, prUrl: string, text: string): Promise<string> {
    const list = this.cursorLaunches.get(prUrl) ?? [];
    list.push(text);
    this.cursorLaunches.set(prUrl, list);
    const id = `agent-${this._nextAgentId++}`;
    const agent: CursorAgent = { id, status: "running", createdAt: new Date().toISOString(), target: { prUrl } };
    const agents = this.cursorAgents.get(prUrl) ?? [];
    agents.push(agent);
    this.cursorAgents.set(prUrl, agents);
    return id;
  }

  async cursorListAgentArtifacts(_apiKey: string, agentId: string): Promise<CursorArtifact[]> {
    return this.cursorArtifacts.get(agentId) ?? [];
  }

  async cursorGetArtifactDownloadUrl(
    _apiKey: string,
    agentId: string,
    absolutePath: string
  ): Promise<{ url: string; expiresAt?: string }> {
    const key = `${agentId}:${absolutePath}`;
    return this.cursorDownloadUrls.get(key) ?? { url: `https://mock-download.test/${agentId}/${absolutePath}` };
  }

  async claudeListAgentsByPrUrl(_apiKey: string, prUrl: string): Promise<ClaudeAgent[]> {
    return this.claudeAgents.get(prUrl) ?? [];
  }

  async claudeFindLatestAgentByPrUrl(_apiKey: string, prUrl: string): Promise<ClaudeAgent | null> {
    const agents = this.claudeAgents.get(prUrl) ?? [];
    if (agents.length === 0) return null;
    const sorted = [...agents].sort((a, b) => {
      const aTs = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTs = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bTs - aTs;
    });
    return sorted[0] ?? null;
  }

  async claudeAddFollowup(_apiKey: string, agentId: string, text: string): Promise<string> {
    const list = this.claudeFollowups.get(agentId) ?? [];
    list.push(text);
    this.claudeFollowups.set(agentId, list);
    return agentId;
  }

  async claudeLaunchAgentForPrUrl(_apiKey: string, prUrl: string, text: string): Promise<string> {
    const list = this.claudeLaunches.get(prUrl) ?? [];
    list.push(text);
    this.claudeLaunches.set(prUrl, list);
    const id = `claude-agent-${this._nextAgentId++}`;
    const agent: ClaudeAgent = { id, status: "running", createdAt: new Date().toISOString(), target: { prUrl } };
    const agents = this.claudeAgents.get(prUrl) ?? [];
    agents.push(agent);
    this.claudeAgents.set(prUrl, agents);
    return id;
  }

  async claudeListAgentArtifacts(_apiKey: string, agentId: string): Promise<ClaudeArtifact[]> {
    return this.claudeArtifacts.get(agentId) ?? [];
  }

  async claudeGetArtifactDownloadUrl(
    _apiKey: string,
    agentId: string,
    absolutePath: string
  ): Promise<{ url: string; expiresAt?: string }> {
    const key = `${agentId}:${absolutePath}`;
    return this.claudeDownloadUrls.get(key) ?? { url: `https://mock-download.test/${agentId}/${absolutePath}` };
  }

  loadConfig(_cwd?: string): Copserc | null {
    return this.config;
  }

  getConfiguredRepos(_cwd?: string): string[] | null {
    if (!this.config?.repos || this.config.repos.length === 0) return null;
    return this.config.repos;
  }

  getOriginRepo(): string | null {
    return this.originRepo;
  }

  loadTemplates(dirPath: string): Map<string, string> {
    return this.templates.get(dirPath) ?? new Map();
  }

  invalidateStatusCache(): void {
    this.statusCacheInvalidations++;
  }
}
