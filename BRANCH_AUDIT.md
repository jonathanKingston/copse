# Branch Audit Report

**Date:** 2026-03-15
**Total branches audited:** 47 (excluding `main`)

---

## Executive Summary

| Category | Count |
|----------|-------|
| **Merge now** | 12 |
| **Merge with minor revisions** | 5 |
| **Needs significant revision** | 4 |
| **Close (empty/already merged)** | 15 |
| **Close (ancient/no merge base)** | 5 |
| **Close (superseded or inappropriate)** | 4 |
| **Delete candidates total** | 24 |

---

## Merge-Ready Branches (Good Quality)

These branches are clean, well-tested, conflict-free, and ready to merge as-is.

| Branch | Changes | What it does |
|--------|---------|-------------|
| `claude/contributing-guide-MWCRt` | +68 | Adds CONTRIBUTING.md with dev setup, project structure, PR process |
| `claude/shared-arg-parser-MWCRt` | +196/-102 | DRY refactor: unified `parseCliArgs()` across 3 commands |
| `claude/expand-dry-run-MWCRt` | +45/-17 | Adds `--dry-run` to `init` and `artifacts` commands |
| `claude/format-tests-MWCRt` | +297 | Comprehensive tests for `lib/format.ts` |
| `claude/status-tui-tests-MWCRt` | +377 | Extracts status helpers into testable module with full tests |
| `claude/env-var-config-MWCRt` | +255 | `COPSE_REPOS`/`COPSE_CURSOR_API_KEY` env var config support |
| `claude/graceful-shutdown-MWCRt` | +20 | SIGTERM/SIGINT graceful shutdown for web server |
| `claude/reduce-github-api-usage-RA6qU` | +200 | Batch GraphQL, reduced limits, configurable poll interval |
| `claude/fish-completion-MWCRt` | +80 | Fish shell completion support |
| `claude/better-gh-errors-MWCRt` | +60 | Actionable `gh` CLI error messages with install/auth guidance |
| `claude/config-tests-MWCRt` | +324 | Tests for `lib/config.ts` covering parsing, validation, edge cases |
| `claude/cli-integration-tests-MWCRt` | +203 | Integration tests for CLI help, subcommands, completions |

---

## Merge With Minor Revisions

| Branch | Rating | Changes | Issues to address |
|--------|--------|---------|-------------------|
| `claude/favicon-meta-MWCRt` | Fair | +14/-1 | `apple-touch-icon` SVG won't work in Safari (needs PNG or removal) |
| `claude/parallel-repo-fetches-MWCRt` | Good | +80/-25 | Silent error swallowing — add `console.error` when repo fetch fails |
| `claude/update-branch-instead-of-pr-ygyDV` | Fair | +108/-21 | Missing tests for `--pr` flag; duplicate `stripMention` helper |
| `cursor/development-environment-setup-fe81` | Good | +22 | Broaden framing beyond "Cursor Cloud specific" |
| `cursor/jest-approval-tests-support-7779` | Good | +294/-12 | Tests write to real `~/.copse/` — use temp directory instead |

---

## Needs Significant Revision

| Branch | Rating | Changes | Issues |
|--------|--------|---------|--------|
| `claude/disk-cache-MWCRt` | Poor | +128 | Stale data risk: no cache invalidation after writes, no `--no-cache` flag, sync I/O in async paths, no tests |
| `claude/code-coverage-MWCRt` | Fair | +4 | Doubles CI test time (runs tests twice); no threshold or reporting. Should replace existing test step or run coverage on one matrix entry only |
| `claude/sdk-api-parity-0VtLN` | Fair | +500+ | Pervasive `if (agent === "claude") ... else if (agent === "cursor")` duplication across 11 files. Needs a shared `AgentApiClient` abstraction |
| `claude/api-request-timeouts-MWCRt` | Fair | +40 | `AbortSignal` not passed to downstream operations — work continues after timeout. Needs signal propagation and tests |

---

## Needs Rebase

| Branch | Rating | Issue |
|--------|--------|-------|
| `claude/code-review-F4N6G` | Good | Valuable bug fixes (substring false positives in `mergeCommitMentionsBranch`, paginated JSON `][` fix) but has merge conflict in `lib/gh.ts`. Rebase onto main, then merge. |

---

## Close / Delete — Empty or Already Merged (15 branches)

All changes from these branches are already in `main`. Safe to delete immediately.

| Branch | Notes |
|--------|-------|
| `claude/api-docs-MWCRt` | Empty |
| `claude/changelog-MWCRt` | Empty |
| `claude/multi-comment-template-response-egD7u` | Empty |
| `claude/refine-web-status-table` | Empty |
| `claude/show-code-changes-views-Uzl5J` | Empty |
| `claude/batch-pr-merge-chain-ekgXc` | Empty |
| `jkt/status` | 14 commits, 0 diff (fully merged) |
| `jkt/web` | Empty |
| `jkt/fallback-help` | Empty |
| `jkt/create-issue` | Empty |
| `cursor/no-30s-refresh-5e36` | Empty |
| `cursor/custom-reporters-support-d1f0` | Empty |
| `cursor/custom-reporter-support-3cb7` | Empty |
| `cursor/truncated-comments-display-f0f1` | Empty |
| `cursor-agent-artifacts` | Empty |

---

## Close / Delete — Ancient, No Merge Base (5 branches)

These diverged before the current `main` existed. Massive phantom diffs (10,000–14,000 lines).

| Branch |
|--------|
| `cursor/copse-dev-static-page-ad90` |
| `cursor/copse-project-renaming-6eef` |
| `cursor/dry-principle-application-b6e0` |
| `cursor/full-typescript-conversion-632f` |
| `cursor/mobile-horizontal-scroll-636c` |

---

## Close — Superseded or Inappropriate for Repo (4 branches)

| Branch | Rating | Reason |
|--------|--------|--------|
| `claude/mockable-api-system-zwNmi` | Poor | Superseded by PR #41 which landed the same feature via a different branch |
| `claude/codebase-improvement-ideas-MWCRt` | Fair | 135-line ideas document — better tracked as individual GitHub issues |
| `cursor/root-cause-analysis-6b55` | Poor | 853-line one-off analysis doc — belongs in an issue/wiki, not repo root |
| `cursor/approval-skip-property-3327` | Poor | Adds unused type definitions only; branch name doesn't match content; dead code |

---

## Close With Reservations

| Branch | Rating | Notes |
|--------|--------|-------|
| `claude/rebrand-site-design-m5oK9` | Fair | Forest-green rebrand is nice but includes a 395-line `preview.html` dev artifact; hardcoded hex colors instead of CSS variables; "Eight commands" vs "Nine commands" inconsistency. Needs cleanup before merge. |

---

## Cross-Cutting Observations

1. **Branch hygiene is poor.** 24 of 47 branches (51%) are empty, ancient, or superseded. These should be cleaned up.
2. **Cursor-generated branch names are misleading.** Several branches have names that don't match their content (e.g., `approval-skip-property` contains Cursor agent types, `jest-approval-tests` contains comment templates).
3. **Test coverage is improving.** Multiple branches add well-structured tests using `node:test`. The project's testing culture is healthy.
4. **No merge conflicts** on any fresh branch. All `MWCRt`-suffixed branches are based on current `main`.
5. **The `sdk-api-parity` branch** is the highest-risk active work — it touches 11 files and introduces a duplication pattern that will compound as more agent backends are added.
