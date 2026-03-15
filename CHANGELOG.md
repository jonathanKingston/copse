# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- PR code changes view in web and TUI dashboards
- Batch chain merge for PRs in web UI
- Stacked PR visibility and stack-aware web filtering
- Standalone branch display in web dashboard
- Multi-comment select and batch template reply in status and web views
- Cursor artifact browsing and run controls in web dashboard
- `--pr` option to `create-issue` for updating existing PR branches via Cursor API
- Batch commit info mock provider tests
- API-layer mock provider for TUI and web

### Changed

- Persist web status cache across server restarts
- Use stale status cache while refreshing GitHub data during refresh
- Refine web PR queueing and draft workflows
- Refine web dashboard filtering and grouping
- Refine inline PR review experience
- Refine web status table responsiveness
- Align conflict status with GitHub mergeability
- Keep status table columns stable while viewing PR details
- Move dashboard status text into the header
- Clarify web comment reply destinations
- Reduce GitHub API usage to avoid rate limits
- Decouple mock bootstrap from low-level providers

### Fixed

- Hide merged standalone branches in web status
- Hide branches after later merge commits
- Revert `listBranches` to fetch all branches without prefix filtering
- Fix flaky standalone branch test to avoid status cache race condition

## [2.0.1] - 2026-03-05

### Fixed

- Fix web dashboard layout and build script
- Simplify docs and web theming

## [2.0.0] - 2026-03-05

### Added

- Web dashboard with real-time PR status monitoring
- Refactored status workflows to support both TUI and web interfaces

### Changed

- Major architecture change: split CLI and web into separate presentation layers over shared status engine

## [1.2.0] - 2026-03-05

### Added

- Canned comment templates and bot comment follow-ups
- Route agent replies through Cursor API when configured
- `init` command to scaffold `.copserc` config and templates
- Issue creation from within the status view
- Body input step to issue creation
- Show formatted, wrapped comments in status TUI instead of truncated single-line

### Changed

- Update `init` command to write to `~/.copserc` instead of local directory
- Keep 30s auto-refresh loop but hide interval from title
- Remove manual `[g]` refresh key binding

### Fixed

- Allow issue creation without PR selection in single-repo mode

## [1.1.1] - 2026-03-05

### Changed

- Improve status TUI filter controls visibility and scope switching

### Fixed

- Fix status TUI reply input line placement
- Preserve co-author matching after follow-up commits
- Use PR created time for status age
- Improve status TUI comment interactions to reduce reply mistakes

## [1.1.0] - 2026-03-03

### Added

- Live search filter to status TUI with `/` key
- MWR (merge when ready) column to status dashboard
- Interactive PR navigation to status `--watch`
- TUI enhancements: default watch mode, comment viewer, checkout, and PR comments
- Inline expanded comments as navigable virtual rows
- Interactive watch controls, comment counts, and signal handling
- Detect agent PRs via co-author and improve status watch UX
- `copse status` command with Copilot support and shared workflow helpers
- `pr-comments` command for viewing and managing PR comments
- PR comment resolve and reply functionality
- Unit tests for PR filtering behavior
- Version bump script

### Changed

- Migrate `spin-up-issue` to `create-issue` command
- Add `@copse/cli` namespace to package
- Split `[a]pprove` and `[m]erge` into separate TUI actions
- Scope CI fetching and bulk operations to search filter
- Pin status TUI footer to terminal bottom with scrollable viewport
- Include dependabot PRs in default filter
- Make status watch fully async so arrow keys stay responsive
- Reduce GitHub API pressure and improve error resilience

### Fixed

- Fail fast with clear errors when `gh` CLI is missing or not authenticated

## [1.0.0] - 2026-02-28

### Added

- Initial release of Copse CLI
- `pr-status` command for monitoring agent-created GitHub PRs
- `create-issue` command to spin up issues for agents
- `rerun-failed` command for re-running failed CI checks
- Full TypeScript codebase
- Documentation site

[Unreleased]: https://github.com/jonathanKingston/copse/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/jonathanKingston/copse/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/jonathanKingston/copse/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/jonathanKingston/copse/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/jonathanKingston/copse/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/jonathanKingston/copse/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jonathanKingston/copse/releases/tag/v1.0.0
