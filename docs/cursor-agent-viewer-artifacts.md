# Cursor agent viewer: artifacts, agent runs, and UX notes

This doc covers the Cursor Cloud Agents **artifact browsing + download** support added to Copse’s:

- local **web dashboard** (`copse web`)
- **CLI** (`copse status` TUI + `copse artifacts` command)

It also captures the current **UX critique** and suggested improvements.

## Background: Cursor Cloud Agents artifacts

Cursor Cloud Agents can produce artifacts (e.g. screenshots, videos, logs) that are listed and downloaded via:

- List artifacts: `GET /v0/agents/:id/artifacts`
- Download presigned URL: `GET /v0/agents/:id/artifacts/download?path=/opt/cursor/artifacts/...`

See Cursor docs: `https://cursor.com/docs/cloud-agent/api/endpoints#agent-artifacts`.

## Configuration

Copse reads a `.copserc` config (global `~/.copserc` or local `.copserc` in repo/parents).

To enable Cursor API features (agent runs + artifacts), set:

```json
{
  "cursorApiKey": "cur_xxx"
}
```

Without `cursorApiKey`:

- the web dashboard still works for GitHub status/comment workflows
- Cursor agent run listing / artifact listing / download are unavailable

## Web: viewing agent runs and artifacts

Start:

```bash
copse web
```

Web UI tips:

- Click a **PR table row** (or use **↑/↓ + Enter**) to load the Comments pane.

Behavior:

- Clicking a **PR table row** loads the **Comments** pane for that PR.
- If `cursorApiKey` is configured, the Comments pane will also attempt to load **Cursor agent runs** for that PR URL:
  - If the PR has Cursor agent runs, a **Cursor artifacts** section appears with:
    - an **Agent run** dropdown (previous agents for this PR)
    - a **Reload** button
    - an artifacts list for the selected run
  - If the PR is not a Cursor PR *and* there are **no** Cursor agent runs, the section stays hidden to keep the UI clean.

Downloads:

- Artifact “Download” links point to the local server, which **302-redirects** to the presigned URL.
- The browser **never sees** your `cursorApiKey`.

### Local web API endpoints (internal)

These endpoints are served by `copse web` (localhost-only by default).

- `GET /api/status`
  - returns PR rows + `cursorApiConfigured`
- `GET /api/pr/:repo/:prNumber/comments`
  - GitHub review comments
- `GET /api/pr/:repo/:prNumber/agents`
  - Cursor agents previously run for this PR URL
- `GET /api/pr/:repo/:prNumber/artifacts?agentId=...`
  - artifacts for the requested agent run
- `GET /api/cursor/agents/:agentId/artifacts/download?path=...`
  - redirects to presigned download URL

## CLI: status TUI artifacts

Run:

```bash
copse status
```

Keys (relevant to artifacts):

- `p`: load Cursor artifacts for the selected PR (lists agent runs + artifacts)
- `d`: download the selected artifact to `./<basename>`
- `o`: when an artifact is selected, open its presigned download URL in the browser

Notes:

- Artifacts require `cursorApiKey`.
- Artifact lists are per **Cursor agent run**, not per PR.
- Download uses a presigned URL and streams to a new file (fails if the file already exists).

## CLI: dedicated artifacts command

List artifacts for the latest Cursor agent linked to a PR URL:

```bash
copse artifacts duckduckgo/content-scope-scripts 2425
```

Download a specific artifact by absolutePath:

```bash
copse artifacts duckduckgo/content-scope-scripts 2425 \
  --download /opt/cursor/artifacts/screenshot.png \
  --out ./screenshot.png
```

## Implementation notes

### How “previously run agents” are determined

The Cursor API supports listing agents filtered by PR URL.

Copse uses:

- `listAgentsByPrUrl(cursorApiKey, prUrl)` to populate the “Agent run” selector
- `findLatestAgentByPrUrl(cursorApiKey, prUrl)` as the default run when no `agentId` is specified

### Security model

- `cursorApiKey` is read on the server (Node) from `.copserc`.
- Web artifact downloads are served as redirects:
  - the server calls Cursor’s download endpoint to obtain a presigned URL
  - the server responds with `302 Location: <presigned-url>`
  - the browser downloads directly from S3

This prevents leaking the Cursor API key to the browser.

### Failure modes and “fail fast”

Web:

- If `cursorApiKey` is missing and an artifacts endpoint is called, the server fails fast with a clear error:
  - `Cursor API not configured. Set "cursorApiKey" in .copserc.`

CLI:

- `copse artifacts` exits non-zero if required args are missing or invalid.
- Downloads are written with `wx` to avoid overwriting existing files.

## UX review notes (current critique)

The current web dashboard looks polished and functional, but it’s starting to feel “dense” as it scales to many PRs.

### Strengths

- Clean, cohesive styling (palette, panels, subtle shadows).
- Strong overall layout choice: status table + details pane.
- Row-click-to-open-details is the right interaction model for triage.
- Local server proxy is the right approach for credentials + CORS.

### Biggest pain points

- **Table density**: too many columns and very tight padding makes scanning hard.
- **Actions noise**: multiple buttons per row competes with the content.
- **Discoverability**: row-click isn’t obvious until you try it.
- **Comments pane width**: can feel cramped for long comments/artifact paths.
- **Accessibility**: limited keyboard navigation and focus affordances.

### Highest-value improvements (suggested next steps)

1. Reduce action clutter (e.g. “More” dropdown; keep only primary actions visible).
2. Improve scannability (row height/padding; widen Title; optional column visibility).
3. Stronger row-click affordance (more obvious hover + selected state indicator).
4. Better loading/error states (spinners, disabled buttons, clearer messages).
5. Add keyboard support (arrow navigation, enter to open, focus management).

Status:

- Implemented in the web dashboard:
  - **“More” actions menu** per row (reduced button clutter)
  - Stronger **hover/selected** styling
  - Clearer **loading/error** states for comments and artifacts
  - **Keyboard navigation** for the status table (↑/↓, Home/End, Enter)

## Troubleshooting

- “Cursor API not configured”
  - Add `"cursorApiKey"` to `.copserc`.
- “No Cursor agent linked to this PR”
  - The PR URL has no Cursor agent runs (or the agent was deleted / not accessible).
- No artifacts found
  - The agent run didn’t produce artifacts, or artifacts have expired (Cursor API limitations may apply).

