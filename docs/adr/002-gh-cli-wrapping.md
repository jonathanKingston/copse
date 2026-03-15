# ADR 002: Wrap the GitHub CLI Instead of Using the GitHub API Directly

## Status

Accepted

## Context

copse needs to interact with GitHub for listing PRs, creating PRs, querying
workflow runs, managing review comments, and more. There are two main
approaches:

1. **Use the GitHub REST/GraphQL API directly** via `fetch` or an HTTP client,
   managing OAuth tokens, pagination, rate-limiting, and error handling
   ourselves.
2. **Wrap the `gh` CLI**, delegating authentication, API transport, pagination,
   and token management to an already-installed tool.

The `gh` CLI is a prerequisite for the workflows copse targets (developers
already use `gh` for PR creation, reviews, and merges). It handles OAuth/token
storage, automatic pagination (`--paginate`), JMESPath queries (`-q`), and
structured JSON output (`--json`), removing significant boilerplate.

## Decision

copse shells out to the `gh` CLI (via `child_process.execFileSync` and
`child_process.execFile`) for all GitHub interactions. The `lib/gh.ts` module
provides typed wrapper functions (`gh()`, `ghQuiet()`, `ghQuietAsync()`) that:

- Call `gh` with the appropriate subcommand and flags.
- Handle retries with exponential backoff on transient 502/503 errors.
- Cache read-only responses (GET requests, non-mutation GraphQL queries) with a
  short TTL to reduce redundant calls during watch/polling loops.
- Surface clear errors when `gh` is missing or not authenticated.

## Consequences

- **No token management.** copse never touches GitHub tokens; `gh auth` handles
  credentials, SSO, and token refresh.
- **Zero HTTP dependencies.** No need for `node-fetch`, `octokit`, or similar
  libraries, which supports the zero-dependency goal (ADR 001).
- **Familiar mental model.** Contributors who know `gh` can predict what copse
  does by reading the arguments passed to each `gh` call.
- **Runtime dependency on `gh`.** Users must install and authenticate the GitHub
  CLI before using copse. This is enforced at startup via `ensureGh()`.
- **Process-per-call overhead.** Each GitHub operation spawns a child process,
  which is slower than in-process HTTP. The caching layer and async variants
  mitigate this for interactive and polling use cases.
- **Output coupling.** copse depends on `gh`'s JSON output format, which could
  change across `gh` versions (though the `--json` contract has been stable).
