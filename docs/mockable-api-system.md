# Mockable API System

Copse talks to GitHub (via the `gh` CLI), the Cursor cloud API, the local
filesystem (config, templates), and git.  The **mockable API system** puts a
single `ApiProvider` interface in front of all of those so that every feature
of the app — TUI dashboard, web UI, and CLI commands — can be tested without
network access or installed tooling.

---

## Architecture at a glance

```
┌──────────────────────────────┐
│        Application code      │  (commands, web server, TUI)
│     calls getProvider().*    │
└──────────────┬───────────────┘
               │
      ┌────────▼────────┐
      │   ApiProvider    │  interface  (lib/api-provider.ts)
      └────────┬────────┘
               │
       ┌───────┴────────┐
       │                │
 ┌─────▼─────┐   ┌─────▼──────────┐
 │  Real      │   │  Mock          │
 │  Provider  │   │  ApiProvider   │   (lib/mock-api-provider.ts)
 │ (default)  │   │  (stateful,    │
 │  wraps     │   │   in-memory)   │
 │  gh.ts,    │   └────────────────┘
 │  cursor-   │
 │  api.ts,   │
 │  config.ts │
 │  etc.      │
 └────────────┘
```

**Key files:**

| File | Purpose |
|---|---|
| `lib/api-provider.ts` | `ApiProvider` interface + global registry (`getProvider`, `setProvider`, `resetProvider`) |
| `lib/mock-api-provider.ts` | `MockApiProvider` class — stateful in-memory backend |
| `tests/mock-api-provider.test.ts` | Tests proving every mock surface works |

---

## Why "stateful system" instead of simple mocks

Simple function mocks (like the existing `StatusActionDeps` pattern) work well
for unit-testing a single function. But for **integration-level** tests that
exercise an entire flow — "create a PR, retarget it, enable auto-merge, then
check the dashboard" — you need state that persists across calls and behaves
realistically:

- Creating a PR via `gh pr create` should make it appear in `listOpenPRs`.
- Closing a PR should remove it from open listings.
- Retargeting should change the stored `baseRefName`.
- Adding a Cursor agent followup should be findable by `findLatestAgentByPrUrl`.

`MockApiProvider` maintains in-memory maps for repos, branches, PRs, workflow
runs, review comments, Cursor agents, config, and templates. Every mutation
updates the same maps that read methods query.

---

## Quick start

### 1. Swap in the mock before your test

```typescript
import { setProvider, resetProvider } from "../lib/api-provider.js";
import { MockApiProvider } from "../lib/mock-api-provider.js";

const mock = new MockApiProvider();
setProvider(mock);
```

### 2. Seed state with helper methods

```typescript
mock.currentUser = "alice";
mock.addRepo("acme/app", { defaultBranch: "main" });
mock.addPR("acme/app", {
  number: 42,
  headRefName: "cursor/fix-bug",
  title: "Fix the bug",
  isDraft: false,
  reviewDecision: "APPROVED",
});
mock.addWorkflowRun("acme/app", "cursor/fix-bug", {
  name: "CI",
  conclusion: "success",
});
mock.addReviewComment("acme/app", 42, {
  body: "Please add a test",
  user: { login: "bob" },
});
```

### 3. Run the code under test

```typescript
// e.g. import a status-action function
import { markPullRequestReady } from "../lib/services/status-actions.js";

// It calls ghQuietAsync internally — the mock intercepts everything.
const result = await markPullRequestReady("acme/app", 42);
```

### 4. Assert on mock state

```typescript
// The mock records all gh calls for fine-grained verification:
assert.deepEqual(mock.ghCalls[0], [
  "pr", "view", "42", "--repo", "acme/app", "--json", "isDraft", "-q", ".isDraft"
]);

// Higher-level: check that a PR comment was posted:
assert.deepEqual(mock.prComments.get("acme/app:42"), ["LGTM"]);

// Track cache invalidation:
assert.equal(mock.statusCacheInvalidations, 1);
```

### 5. Clean up

```typescript
mock.reset();      // wipe all in-memory state
resetProvider();   // restore the real provider for other tests
```

---

## Full API reference

### Setup helpers

| Method | Description |
|---|---|
| `addRepo(repo, options?)` | Register a repo with default branch and merge strategy settings |
| `addBranch(repo, name, commitInfo?)` | Add a branch with optional commit metadata |
| `addPR(repo, pr)` | Add a PR (auto-assigns number, timestamps, defaults) |
| `addWorkflowRun(repo, branch, run)` | Add a CI workflow run |
| `addReviewComment(repo, prNumber, comment)` | Add a review comment |
| `addCursorAgent(prUrl, agent?)` | Add a Cursor cloud agent for a PR |
| `reset()` | Wipe **all** state back to empty defaults |

### Inspectable state

All state is stored as public `Map` / array fields, so tests can read or
mutate them directly:

| Field | Key format | Value |
|---|---|---|
| `repos` | `"owner/name"` | `MockRepo` (branch, merge settings) |
| `branches` | `"owner/name"` | `string[]` |
| `prs` | `"owner/name"` | `MockPR[]` |
| `workflowRuns` | `"owner/name:branch"` | `WorkflowRun[]` |
| `commits` | `"owner/name:ref"` | `CommitInfo` |
| `reviewComments` | `"owner/name:prNumber"` | `PRReviewComment[]` |
| `reviewThreads` | `"owner/name:prNumber"` | `MockReviewThread[]` |
| `prComments` | `"owner/name:prNumber"` | `string[]` (bodies) |
| `prReplies` | `"owner/name:prNumber:commentId"` | `string[]` (bodies) |
| `prFiles` | `"owner/name:prNumber"` | `PRChangedFile[]` |
| `cursorAgents` | PR URL | `CursorAgent[]` |
| `cursorArtifacts` | agent ID | `CursorArtifact[]` |
| `cursorFollowups` | agent ID | `string[]` (texts) |
| `cursorLaunches` | PR URL | `string[]` (texts) |
| `ghCalls` | — | `string[][]` (all raw gh arg arrays) |
| `statusCacheInvalidations` | — | `number` (counter) |

### gh passthrough behaviour

The mock interprets common `gh` subcommands so that code using `ghQuietAsync`
for mutations works realistically:

| Command pattern | Mock behaviour |
|---|---|
| `pr view` with `--json isDraft` | Returns the PR's `isDraft` field |
| `pr view` with `--json baseRefName` | Returns the PR's `baseRefName` |
| `pr edit --base <branch>` | Updates `baseRefName` on the stored PR |
| `pr merge --auto --squash` | Sets `autoMergeRequest` on the PR |
| `pr merge` (without `--auto`) | Sets PR state to `"merged"` |
| `pr ready` | Sets `isDraft = false` |
| `pr review --approve` | Sets `reviewDecision = "APPROVED"` |
| `pr close` | Sets state to `"closed"` |
| `pr comment --body <text>` | Appends to `prComments` |
| `pr create` | Creates a new MockPR, returns URL |
| `pr list` | Returns open PRs as JSON |
| `run list` | Returns workflow runs as JSON |
| `run rerun` | Resets the run's conclusion/status |
| `issue create` | Returns a new issue URL |
| `api repos/{repo}` | Returns repo metadata / merge settings |
| `api repos/{repo}/merges` | Returns a mock merge SHA |
| `api user` | Returns `{ login: currentUser }` |
| `api graphql` | Returns minimal valid responses for review thread and co-author queries |

All calls — interpreted or not — are appended to `mock.ghCalls` for
assertion.

---

## Using with the existing StatusActionDeps pattern

The existing `status-actions.ts` functions accept an optional `deps` parameter
for unit tests. The mock provider is **complementary**: it covers the same
surface at a higher level.

You can use them together. For focused unit tests, keep using `deps` overrides.
For broader integration tests or for testing the web/TUI layers, use
`setProvider(mock)`.

The mock's `ghQuietAsync` can also be extracted as a `StatusActionDeps`-compatible
value:

```typescript
const mock = new MockApiProvider();
const deps = {
  ghQuietAsync: mock.ghQuietAsync.bind(mock),
  addPRCommentAsync: mock.addPRCommentAsync.bind(mock),
  getCommitInfoAsync: mock.getCommitInfoAsync.bind(mock),
  getDefaultBranchAsync: mock.getDefaultBranchAsync.bind(mock),
  invalidateStatusCache: mock.invalidateStatusCache.bind(mock),
};
```

---

## Resetting between tests

Call `mock.reset()` to wipe all state. This clears every map, resets
auto-increment counters, and restores `currentUser` to `"test-user"`.

If you share a single `MockApiProvider` across tests (e.g. in a `beforeEach`),
always reset:

```typescript
let mock: MockApiProvider;

test.beforeEach(() => {
  mock = new MockApiProvider();
  setProvider(mock);
});

test.afterEach(() => {
  resetProvider();
});
```

Or create a fresh instance per test — there's no global state inside the mock
itself; the only global is the provider registry, managed by `setProvider` /
`resetProvider`.

---

## Extending the mock

If an app feature needs a new external call, add the method to the
`ApiProvider` interface in `lib/api-provider.ts`, implement it in the real
provider (delegating to the existing module), and implement it in
`MockApiProvider` with appropriate in-memory state.

The pattern for every method is the same:

1. **Store state** in a public map/field so tests can seed and inspect it.
2. **Return realistic values** so downstream code works unchanged.
3. **Log the call** (the `ghCalls` array) if fine-grained assertion is useful.
