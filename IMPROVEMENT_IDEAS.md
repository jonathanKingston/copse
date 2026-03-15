# Copse Codebase Improvement Ideas

50 actionable improvement ideas for the copse codebase, organized by category.

---

## Architecture & Code Organization

1. **Split `status.ts` into modules** — At 1864 lines, `commands/status.ts` is the largest file. Extract TUI rendering, keyboard handling, and state management into separate modules under `commands/status/`.

2. **Extract ANSI constants into `lib/format.ts`** — The `ANSI` object in `status.ts` duplicates formatting constants already partially in `lib/format.ts`. Consolidate all ANSI helpers in one place.

3. **Create a shared CLI argument parser** — Commands like `approval.ts`, `create-prs.ts`, and `rerun-failed.ts` each parse positional args manually. A lightweight shared parser would reduce duplication.

4. **Introduce a `Command` interface with lifecycle hooks** — Each command exports a default function. A formal interface with `validate()`, `run()`, and `cleanup()` would standardize error handling and resource cleanup.

5. **Move web server route handlers into separate files** — `web/server.ts` at 21KB handles all API routes inline. Extract route handlers into `web/routes/` modules (e.g., `status.ts`, `comments.ts`, `actions.ts`).

6. **Create a shared PR data model** — `PRWithStatus`, `PR`, and the web dashboard row objects represent similar data. Unify into a single canonical type with view-specific projections.

---

## Testing

7. **Add tests for `gh.ts` caching logic** — The read cache in `gh.ts` (pruning, TTL, max entries) has no test coverage. Mock `execFile` and verify cache hits, expiry, and eviction.

8. **Add tests for `config.ts` edge cases** — Test malformed JSON, missing fields, deeply nested directory search, and home directory fallback.

9. **Add integration tests for CLI commands** — CI only verifies `--help` flags run. Add integration tests that mock `gh` and verify actual command output.

10. **Add tests for `format.ts`** — ANSI-aware text wrapping and markdown rendering have no tests. These are pure functions ideal for unit testing.

11. **Add tests for the `status.ts` TUI logic** — Extract pure functions (urgency calculation, search matching, table rendering) and test them independently.

12. **Increase web server test coverage** — `web-server.test.ts` is only 57 lines. Add tests for error paths, malformed requests, CORS, and all API endpoints.

13. **Add snapshot tests for TUI output** — Capture expected terminal output for status/pr-status commands to detect visual regressions.

14. **Set up code coverage reporting** — Add `c8` or Node's built-in coverage (`--experimental-test-coverage`) to CI and track coverage over time.

---

## Error Handling & Robustness

15. **Add structured error types** — Replace generic `throw new Error(...)` with typed error classes (e.g., `GitHubApiError`, `ConfigError`, `ValidationError`) for better error handling.

16. **Add graceful shutdown to web server** — The web server doesn't handle SIGTERM/SIGINT gracefully. Add proper connection draining and cleanup.

17. **Add request body size limits** — `readJsonBody` in `server.ts` reads the entire body into memory without size limits. Add a max body size check to prevent memory exhaustion.

18. **Improve gh CLI error messages** — When `gh` is not installed or not authenticated, surface a clear, actionable error message instead of a raw exec error.

19. **Add timeout handling for web API endpoints** — Long-running `gh` calls from web endpoints have no per-request timeout. Add abort signals to prevent hanging requests.

20. **Handle concurrent config file changes** — `loadConfig` reads synchronously and could get stale. Add file-watching or TTL-based refresh for long-running processes (web server, watch mode).

---

## Developer Experience

21. **Add a `--verbose` / `--debug` flag** — No way to see what `gh` commands are being run under the hood. A debug mode logging all subprocess calls would help troubleshoot issues.

22. **Add a `--json` output flag for CLI commands** — Enable machine-readable output for scripting and piping. Commands like `pr-status` and `status --no-watch` would benefit.

23. **Add fish shell completion** — Only bash and zsh are supported. Fish is increasingly popular among developers.

24. **Add a `copse doctor` command** — Check for `gh` installation, authentication, config validity, and Node version. Surface all issues at once instead of failing one-by-one.

25. **Add a `copse config` command** — View and edit `.copserc` values from the CLI instead of manually editing JSON.

26. **Support environment variables for config** — Allow `COPSE_REPOS`, `COPSE_CURSOR_API_KEY` etc. as alternatives to `.copserc`, useful for CI environments.

27. **Add `--dry-run` to more commands** — Only `approval`, `create-prs`, `rerun-failed`, and `create-issue` support dry-run. Add it to `update-main` and bulk actions.

---

## Performance

28. **Parallelize multi-repo fetches** — `fetchPRsWithStatus` processes repos sequentially via `gh`. Use `Promise.all` with concurrency limiting to fetch repos in parallel.

29. **Add ETag / conditional request support for gh API cache** — The current cache uses TTL-based expiry. GitHub's API supports ETags for conditional requests, reducing bandwidth.

30. **Lazy-load command modules** — All commands are imported at startup via the router. Use dynamic `import()` to only load the command being invoked, improving CLI startup time.

31. **Add persistent disk cache for gh API responses** — The in-memory cache is lost between CLI invocations. A disk cache (with TTL) would speed up repeated runs.

32. **Optimize web dashboard polling** — The client polls every 30s with a full refresh. Implement server-sent events (SSE) or WebSocket for push-based updates.

33. **Debounce text filter input in web UI** — The text filter triggers a re-render on every keystroke. Add a debounce (e.g., 200ms) for smoother UX with large PR lists.

---

## Web Dashboard

34. **Add dark mode to web dashboard** — The dashboard only has a light theme. Add a dark mode toggle using CSS custom properties (the var system is already in place).

35. **Add keyboard shortcuts to web dashboard** — Document and implement keyboard shortcuts (e.g., `r` to refresh, `/` to focus search, `a` to approve selected, `m` to merge).

36. **Add URL-based state/routing** — Filter state (repos, scope, search query) is lost on page refresh. Persist filters in URL query parameters.

37. **Add a loading skeleton UI** — The dashboard shows a blank state during initial load. Add skeleton placeholders for better perceived performance.

38. **Add toast/notification system** — Bulk action results are shown inline. Add a toast notification system for transient success/error feedback.

39. **Make the web dashboard responsive/mobile-friendly** — The two-panel layout doesn't work well on narrow screens. Add responsive breakpoints.

40. **Add favicon and meta tags** — The web dashboard has no favicon or OpenGraph meta tags. Add them for better browser tab identification.

---

## Security

41. **Add CSRF protection to web server** — The local web server accepts POST requests without any CSRF token verification. Add a per-session token.

42. **Add Content-Security-Policy headers** — The web server serves HTML without CSP headers. Add strict CSP to prevent XSS.

43. **Sanitize PR body/comment HTML** — PR bodies and comments rendered in the web UI could contain malicious HTML. Ensure proper sanitization.

44. **Add rate limiting to web API** — The web server has no rate limiting on POST endpoints. Add basic rate limiting to prevent abuse if exposed.

---

## Documentation & Maintainability

45. **Add JSDoc to all public functions in `lib/`** — Several exported functions in `gh.ts`, `filters.ts`, and `utils.ts` lack documentation.

46. **Add a CONTRIBUTING.md** — No contribution guide exists. Document development setup, testing, code style, and PR process.

47. **Add a CHANGELOG.md** — Version history is only tracked via git commits. A changelog would help users understand what changed between releases.

48. **Document the web API endpoints** — The web server's REST API is undocumented. Add OpenAPI/Swagger docs or at minimum a markdown reference.

49. **Add architecture decision records (ADRs)** — Key decisions (zero dependencies, gh CLI wrapping, local-only web server) deserve documentation explaining the rationale.

50. **Add inline comments for complex algorithms** — The GraphQL chunking in `gh.ts`, the cache decision logic, and the TUI rendering loop in `status.ts` would benefit from explanatory comments.
