# Copse Web API Reference

The Copse web server exposes a JSON API for managing AI-generated pull requests. It runs locally (default `127.0.0.1:4317`) and requires no authentication.

All API endpoints are prefixed with `/api/`. Non-API paths serve the static web dashboard.

## Common Behavior

- **Content-Type**: All responses use `application/json; charset=utf-8`.
- **Error handling**: On error, all endpoints return HTTP 400 with `{ "error": "<message>" }`.
- **Repo resolution**: Many endpoints accept an optional `repos` query parameter (comma-separated `owner/repo` values). If omitted, repos are resolved from the current git origin or from `.copserc` configuration.
- **404**: Unknown API paths return `{ "error": "Endpoint not found" }` with HTTP 404.

---

## Status

### GET /api/status

Fetch the status of all tracked pull requests.

**Query Parameters**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `repos` | string | *(auto-detected)* | Comma-separated list of `owner/repo` values |
| `scope` | string | `"my-stacks"` | Filter scope: `"my-stacks"` or `"all"` |
| `mineOnly` | string | — | Legacy parameter; `"false"` maps to scope `"all"` |

**Response** `200`

```json
{
  "repos": ["owner/repo"],
  "scope": "my-stacks",
  "pollIntervalMs": 30000,
  "rows": [ ... ],
  "cursorApiConfigured": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `repos` | string[] | Repos that were queried |
| `scope` | string | The active filter scope |
| `pollIntervalMs` | number | Suggested polling interval in milliseconds (30000) |
| `rows` | array | PR status rows (structure defined by `fetchPRsWithStatus`) |
| `cursorApiConfigured` | boolean | Whether a Cursor API key is configured |

---

## Templates

### GET /api/templates

List configured comment templates.

**Response** `200`

```json
{
  "templates": [
    { "label": "Approve", "body": "LGTM!" },
    { "label": "Request changes", "body": "Please address the following..." }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `templates` | array | List of `{ label, body }` template objects |

---

## Comments

### GET /api/pr/{owner/repo}/{prNumber}/comments

List review comments on a pull request.

**Path Parameters**

| Name | Type | Description |
|------|------|-------------|
| `owner/repo` | string | Repository in `owner/repo` format (URL-encoded as a single segment, e.g. `owner%2Frepo`) |
| `prNumber` | integer | Pull request number |

**Response** `200`

```json
{
  "repo": "owner/repo",
  "prNumber": 42,
  "comments": [ ... ]
}
```

### GET /api/pr/{owner/repo}/{prNumber}/files

List files changed in a pull request.

**Path Parameters**

Same as comments endpoint above.

**Response** `200`

```json
{
  "repo": "owner/repo",
  "prNumber": 42,
  "files": [ ... ]
}
```

### POST /api/pr/{owner/repo}/{prNumber}/comment

Post a general comment on a pull request.

**Request Body**

```json
{
  "body": "Comment text here"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | string | Yes | The comment text |

**Response** `200`

```json
{
  "ok": true,
  "message": "Comment posted"
}
```

### POST /api/pr/{owner/repo}/{prNumber}/reply

Reply to a specific review comment.

**Request Body**

```json
{
  "body": "Reply text",
  "inReplyToId": 123456,
  "delivery": "github"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | string | Yes | The reply text |
| `inReplyToId` | integer | Yes | The ID of the comment to reply to (must be positive) |
| `delivery` | string | No | `"github"` (default) or `"cursor"`. When `"cursor"`, the reply is sent via the Cursor API instead of posted on GitHub |

**Response** `200`

```json
{
  "ok": true,
  "mode": "github",
  "message": "Reply posted in GitHub thread"
}
```

The `mode` field will be one of:
- `"github"` -- reply posted as a GitHub comment
- `"cursor-followup"` -- reply sent to an existing Cursor agent
- `"cursor-launch"` -- no linked agent found; a new Cursor agent was launched

### POST /api/pr/{owner/repo}/{prNumber}/batch-reply

Reply to multiple review comments at once.

**Request Body**

```json
{
  "body": "Reply text for all selected comments",
  "commentIds": [123456, 789012],
  "delivery": "github"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | string | Yes | The reply text |
| `commentIds` | integer[] | Yes | Non-empty array of comment IDs to reply to |
| `delivery` | string | No | `"github"` (default) or `"cursor"` |

**Response** `200` (GitHub delivery)

```json
{
  "ok": true,
  "total": 2,
  "message": "Replied to 2 comment(s)"
}
```

**Response** `200` (Cursor delivery)

```json
{
  "ok": true,
  "total": 2,
  "mode": "cursor-followup",
  "message": "Sent Cursor follow-up with 2 selected comment(s)"
}
```

---

## PR Actions

### POST /api/pr/{owner/repo}/{prNumber}/approve

Approve a pull request.

**Request Body**: Empty or `{}`

**Response** `200`

```json
{
  "ok": true,
  "message": "Approved PR"
}
```

### POST /api/pr/{owner/repo}/{prNumber}/ready

Mark a draft pull request as ready for review.

**Request Body**: Empty or `{}`

**Response** `200`

```json
{
  "ok": true,
  "alreadyReady": false,
  "message": "Marked PR ready for review"
}
```

### POST /api/pr/{owner/repo}/{prNumber}/rerun

Re-run failed workflow runs for a PR's branch.

**Request Body**

```json
{
  "headRefName": "feature-branch"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `headRefName` | string | Yes | The branch name to rerun workflows for |

**Response** `200`

```json
{
  "ok": true,
  "total": 1,
  "message": "Reran 1 workflow(s)"
}
```

### POST /api/pr/{owner/repo}/{prNumber}/update-main

Merge the main branch into the PR's branch.

**Request Body**

```json
{
  "headRefName": "feature-branch"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `headRefName` | string | Yes | The branch name to merge main into |

**Response** `200`

```json
{
  "ok": true,
  "alreadyUpToDate": false,
  "message": "Merged main into branch"
}
```

### POST /api/pr/{owner/repo}/{prNumber}/retarget

Change the base branch of a pull request.

**Request Body**

```json
{
  "baseBranch": "main"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseBranch` | string | Yes | The new base branch |

**Response** `200`

```json
{
  "ok": true,
  "closedRedundant": false,
  "alreadyTargeted": false,
  "message": "Retargeted PR to main"
}
```

If the PR has no unique commits beyond the new base, it is closed instead:

```json
{
  "ok": true,
  "closedRedundant": true,
  "alreadyTargeted": false,
  "message": "Closed PR after finding no commits unique beyond main"
}
```

### POST /api/pr/{owner/repo}/{prNumber}/merge-auto

Enable auto-merge (merge when ready) on a pull request.

**Request Body**: Empty or `{}`

**Response** `200`

```json
{
  "ok": true,
  "alreadyEnabled": false,
  "message": "Merge when ready enabled"
}
```

---

## Issues and Branches

### POST /api/issues

Create a new GitHub issue with an optional agent-triggering comment.

**Request Body**

```json
{
  "repo": "owner/repo",
  "title": "Issue title",
  "body": "Issue body text",
  "agent": "cursor",
  "templateChoice": 0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | string | Yes | Repository in `owner/repo` format |
| `title` | string | Yes | Issue title |
| `body` | string | No | Issue body |
| `agent` | string | No | Agent type (default: `"cursor"`) |
| `templateChoice` | integer | Yes | Template index: `0`, `1`, `2`, or `3` |

**Response** `200`

```json
{
  "ok": true,
  "issueNumber": 99,
  "commentAdded": true,
  "message": "Created issue #99 with comment"
}
```

### POST /api/branches/create-pr

Create a pull request from an existing branch.

**Request Body**

```json
{
  "repo": "owner/repo",
  "headRefName": "feature-branch"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | string | Yes | Repository in `owner/repo` format |
| `headRefName` | string | Yes | Branch name to create PR from |

**Response** `200`

```json
{
  "ok": true,
  "repo": "owner/repo",
  "headRefName": "feature-branch",
  "baseBranch": "main",
  "title": "Feature branch",
  "url": "https://github.com/owner/repo/pull/100",
  "message": "Created PR for feature-branch into main"
}
```

### POST /api/chain-merge

Queue a chain of stacked PRs for sequential merging.

**Request Body**

```json
{
  "repo": "owner/repo",
  "prs": [
    { "number": 10, "headRefName": "stack-1" },
    { "number": 11, "headRefName": "stack-2" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | string | Yes | Repository in `owner/repo` format |
| `prs` | array | Yes | Array of at least 2 objects, each with `number` (positive integer) and `headRefName` (string) |

**Response** `200`

```json
{
  "ok": true,
  "steps": [ ... ],
  "stoppedEarly": false,
  "message": "Stack queued: 2 step(s)"
}
```

---

## Cursor / Artifacts

These endpoints require a Cursor API key configured in `.copserc` (`cursorApiKey`). If the key is missing, they return a 400 error: `Cursor API not configured. Set "cursorApiKey" in .copserc.`

### GET /api/pr/{owner/repo}/{prNumber}/artifacts

List artifacts from the Cursor agent associated with a pull request.

**Path Parameters**

| Name | Type | Description |
|------|------|-------------|
| `owner/repo` | string | Repository in `owner/repo` format |
| `prNumber` | integer | Pull request number |

**Query Parameters**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `agentId` | string | *(latest agent)* | Specific Cursor agent ID. If omitted, the latest agent for the PR is used. |

**Response** `200`

```json
{
  "repo": "owner/repo",
  "prNumber": 42,
  "prUrl": "https://github.com/owner/repo/pull/42",
  "agentId": "agent-abc123",
  "artifacts": [ ... ]
}
```

When no agent is found:

```json
{
  "repo": "owner/repo",
  "prNumber": 42,
  "prUrl": "https://github.com/owner/repo/pull/42",
  "agentId": null,
  "artifacts": []
}
```

### GET /api/pr/{owner/repo}/{prNumber}/agents

List all Cursor agents that have run for a pull request.

**Path Parameters**

Same as the artifacts endpoint above.

**Response** `200`

```json
{
  "repo": "owner/repo",
  "prNumber": 42,
  "prUrl": "https://github.com/owner/repo/pull/42",
  "agents": [ ... ]
}
```

### GET /api/cursor/agents/{agentId}/artifacts/download

Redirect to a presigned download URL for a Cursor agent artifact. The Cursor API key is kept server-side.

**Path Parameters**

| Name | Type | Description |
|------|------|-------------|
| `agentId` | string | Cursor agent ID |

**Query Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Absolute file path of the artifact to download |

**Response** `302` -- Redirects to the presigned download URL with `Cache-Control: no-store`.

**Error** `400` -- if `path` query parameter is missing.
