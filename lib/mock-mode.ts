import { getApiProvider, setApiProvider } from "./api-provider.js";
import { MockApiProvider } from "./mock-api-provider.js";

const MOCK_MODE_ENV_KEYS = ["COPSE_MOCK_MODE", "COPSE_USE_MOCK_PROVIDER"];

let mockModeInitialized = false;

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isMockModeEnabled(): boolean {
  return MOCK_MODE_ENV_KEYS.some((key) => isTruthy(process.env[key]));
}

function seedMockData(mock: MockApiProvider): void {
  const repo = (process.env.COPSE_MOCK_REPO || "jonathanKingston/copse").trim();
  const user = (process.env.COPSE_MOCK_USER || "mock-user").trim();

  mock.currentUser = user;
  mock.originRepo = repo;
  mock.config = {
    repos: [repo],
    cursorApiKey: "cur_mock_api_key",
  };

  mock.addRepo(repo, {
    defaultBranch: "main",
    allowSquashMerge: true,
    allowMergeCommit: true,
    allowRebaseMerge: true,
  });

  mock.addBranch(repo, "claude/mockable-api-system-zwNmi", {
    message: "Add mockable API system for testing TUI and web UIs without network access",
    authorLogin: "claude",
    date: new Date("2026-03-15T13:37:25Z"),
  });
  mock.addBranch(repo, "cursor/mock-mode-stack-a", {
    message: "Mock mode stack A",
    authorLogin: user,
    date: new Date("2026-03-15T13:20:00Z"),
  });
  mock.addBranch(repo, "cursor/mock-mode-stack-b", {
    message: "Mock mode stack B",
    authorLogin: user,
    date: new Date("2026-03-15T13:19:00Z"),
  });

  mock.addPR(repo, {
    number: 201,
    headRefName: "cursor/mock-mode-stack-a",
    baseRefName: "main",
    title: "Mock mode stack A",
    author: { login: user },
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    createdAt: new Date("2026-03-15T13:20:00Z").toISOString(),
    updatedAt: new Date("2026-03-15T13:20:00Z").toISOString(),
  });
  mock.addPR(repo, {
    number: 202,
    headRefName: "cursor/mock-mode-stack-b",
    baseRefName: "main",
    title: "Mock mode stack B",
    author: { login: user },
    isDraft: false,
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    createdAt: new Date("2026-03-15T13:19:00Z").toISOString(),
    updatedAt: new Date("2026-03-15T13:19:00Z").toISOString(),
  });

  mock.addWorkflowRun(repo, "cursor/mock-mode-stack-a", {
    databaseId: 9001,
    name: "CI",
    conclusion: "failure",
    status: "completed",
    displayTitle: "CI",
    attempt: 1,
  });
  mock.addWorkflowRun(repo, "cursor/mock-mode-stack-b", {
    databaseId: 9002,
    name: "CI",
    conclusion: "success",
    status: "completed",
    displayTitle: "CI",
    attempt: 1,
  });

  const comment = mock.addReviewComment(repo, 201, {
    id: 8101,
    node_id: "MDI_mock_comment_8101",
    body: "Please add a persistence test for mock mode.",
    path: "lib/mock-api-provider.ts",
    line: 42,
    original_line: 42,
    user: { login: "reviewer-bot", type: "Bot" },
  });
  mock.reviewThreads.set(`${repo}:201`, [{
    id: "thread-201-a",
    isResolved: false,
    commentNodeIds: [comment.node_id],
  }]);

  mock.prFiles.set(`${repo}:201`, [{
    sha: "abc201",
    filename: "lib/mock-api-provider.ts",
    status: "modified",
    additions: 24,
    deletions: 3,
    changes: 27,
    patch: "@@ -1,2 +1,3 @@\n+mock mode wiring",
  }]);
  mock.prFiles.set(`${repo}:202`, [{
    sha: "abc202",
    filename: "web/server.ts",
    status: "modified",
    additions: 10,
    deletions: 2,
    changes: 12,
    patch: "@@ -10,2 +10,3 @@\n+provider delegation",
  }]);

  const prUrl = `https://github.com/${repo}/pull/201`;
  const agent = mock.addCursorAgent(prUrl, {
    id: "agent-mock-201",
    status: "completed",
    createdAt: new Date("2026-03-15T13:22:00Z").toISOString(),
    target: { prUrl },
  });
  mock.cursorArtifacts.set(agent.id, [{
    absolutePath: "/opt/cursor/artifacts/mock_mode_validation.log",
    sizeBytes: 2048,
    updatedAt: new Date("2026-03-15T13:23:00Z").toISOString(),
  }]);

  mock.templates.set("/mock/templates", new Map([
    ["please-fix", "Please fix this in mock mode."],
  ]));
}

export function ensureMockProviderConfigured(): void {
  if (mockModeInitialized) return;
  mockModeInitialized = true;
  if (!isMockModeEnabled()) return;
  if (getApiProvider()) return;
  const mock = new MockApiProvider();
  seedMockData(mock);
  setApiProvider(mock);
}
