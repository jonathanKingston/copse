# ADR 003: Local-Only Web Server

## Status

Accepted

## Context

The `copse web` command runs an HTTP server that provides a browser-based
dashboard for PR status, review comments, issue creation, reruns, and merge
workflows. This server executes GitHub API calls using the local user's `gh`
authentication.

Because the server acts on behalf of the authenticated user -- approving PRs,
posting comments, enabling auto-merge, creating issues -- exposing it to the
network would grant anyone who can reach the port full access to those
operations without additional authentication.

## Decision

The web server binds to `127.0.0.1` (localhost) by default, making it
accessible only from the local machine. The `--host` and `--port` flags allow
overriding, but the safe default ensures the server is not exposed to the
network out of the box.

The server uses Node.js's built-in `node:http` module directly (`createServer`)
with hand-rolled routing, static file serving, and JSON request/response
handling -- no framework dependencies.

## Consequences

- **Secure by default.** Binding to `127.0.0.1` means remote machines cannot
  reach the server unless the user explicitly overrides the host. There is no
  risk of accidentally exposing GitHub credentials or write operations.
- **No authentication layer needed.** Since only the local user can connect,
  the server does not need its own auth system, session management, or CORS
  configuration. This keeps the implementation simple.
- **Single-user design.** The server is intended for one developer at a time,
  using their own `gh` credentials. This matches the CLI-tool mental model.
- **Not suitable for shared/team dashboards.** If a team wanted a shared web
  view, they would need a separate deployment with proper authentication. This
  is an intentional scope boundary.
- **Framework-free routing.** The server parses URLs and dispatches to handlers
  manually, consistent with the zero-dependency approach (ADR 001). This means
  more code for routing logic, but no framework coupling.
