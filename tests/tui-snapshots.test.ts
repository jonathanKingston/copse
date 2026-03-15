/**
 * Snapshot tests for TUI output rendered by the pr-status command and
 * the shared formatting helpers in lib/format.ts.
 *
 * Uses a simple file-based snapshot approach: expected output is written to
 * .snap files in tests/snapshots/. On the first run the snapshots are created;
 * on subsequent runs the rendered output is compared against them.
 *
 * Set UPDATE_SNAPSHOTS=1 to regenerate all snapshots.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkflowRun } from "../lib/types.js";
import { formatCommentBody, wrapAnsiText } from "../lib/format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = join(__dirname, "..", "..", "tests", "snapshots");

// Ensure snapshots directory exists at runtime (compiled JS runs from dist/).
if (!existsSync(SNAPSHOTS_DIR)) {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

// ANSI escape sequences (local copy; not exported from lib/format.ts).
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function assertSnapshot(name: string, actual: string): void {
  const snapPath = join(SNAPSHOTS_DIR, `${name}.snap`);
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(snapPath)) {
    writeFileSync(snapPath, actual, "utf-8");
    return; // snapshot written; nothing to assert yet
  }
  const expected = readFileSync(snapPath, "utf-8");
  assert.equal(actual, expected, `Snapshot mismatch for "${name}". Run with UPDATE_SNAPSHOTS=1 to update.`);
}

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    databaseId: 1001,
    name: "CI",
    conclusion: "success",
    attempt: 1,
    status: "completed",
    displayTitle: "CI",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rendering helper (mirrors the pure output logic from commands/pr-status.ts)
//
// We re-implement the rendering here rather than importing directly from the
// command file, because it calls process.exit / initializeRuntime on load.
// ---------------------------------------------------------------------------

function renderPRStatusOutput(
  repo: string,
  prs: Array<{
    pr: { number: number; headRefName: string; title: string };
    runs: WorkflowRun[];
  }>,
  columns: number,
): string {
  const lines: string[] = [];

  for (const { pr, runs } of prs) {
    const failed = runs.filter((r) => r.conclusion === "failure");
    const prUrl = `https://github.com/${repo}/pull/${pr.number}`;
    // In non-TTY mode hyperlink() returns plain text, so we use plain text.
    const heading = `#${pr.number} ${pr.headRefName}`;
    lines.push(heading);

    const indent = 2;
    const maxTitleWidth = Math.max(20, columns - indent);
    const titleShort = (pr.title || "").slice(0, maxTitleWidth);
    const suffix = (pr.title || "").length > maxTitleWidth ? "\u2026" : "";
    lines.push(`  ${titleShort}${suffix}`);
    lines.push(`  ${prUrl}`);

    if (failed.length === 0) {
      const inProgress = runs.filter(
        (r) =>
          r.status === "in_progress" ||
          r.status === "queued" ||
          r.status === "requested",
      );
      if (inProgress.length > 0) {
        lines.push(`  CI: ${inProgress.length} run(s) in progress`);
      } else {
        const lastSuccess = runs.find((r) => r.conclusion === "success");
        lines.push(`  CI: ${lastSuccess ? "passing" : "no runs"}`);
      }
    } else {
      const byWorkflow = new Map<string, WorkflowRun[]>();
      for (const r of failed) {
        const key = r.name || r.displayTitle || `Run #${r.databaseId}`;
        if (!byWorkflow.has(key)) {
          byWorkflow.set(key, []);
        }
        byWorkflow.get(key)!.push(r);
      }
      for (const [workflow, workflowRuns] of byWorkflow) {
        const attempts = workflowRuns
          .map((r) => `attempt ${r.attempt ?? 1}`)
          .join(", ");
        const runIds = workflowRuns.map((r) => r.databaseId).join(", ");
        const rerunCount = workflowRuns.filter(
          (r) => (r.attempt ?? 1) > 1,
        ).length;
        const rerunNote =
          rerunCount > 0
            ? ` (${rerunCount} rerun${rerunCount > 1 ? "s" : ""})`
            : "";
        lines.push(
          `  FAILED: ${workflow} [${attempts}] run #${runIds}${rerunNote}`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests: pr-status output rendering
// ---------------------------------------------------------------------------

test("pr-status: single PR with passing CI", () => {
  const output = renderPRStatusOutput(
    "acme/widgets",
    [
      {
        pr: {
          number: 42,
          headRefName: "cursor/fix-login",
          title: "Fix login flow for SSO users",
        },
        runs: [makeWorkflowRun({ conclusion: "success" })],
      },
    ],
    80,
  );

  assertSnapshot("pr-status-passing-ci", output);
});

test("pr-status: PR with failed CI and reruns", () => {
  const output = renderPRStatusOutput(
    "acme/widgets",
    [
      {
        pr: {
          number: 99,
          headRefName: "claude/add-tests",
          title: "Add unit tests for auth module",
        },
        runs: [
          makeWorkflowRun({
            databaseId: 2001,
            name: "Tests",
            conclusion: "failure",
            attempt: 1,
          }),
          makeWorkflowRun({
            databaseId: 2002,
            name: "Tests",
            conclusion: "failure",
            attempt: 2,
          }),
          makeWorkflowRun({
            databaseId: 2003,
            name: "Lint",
            conclusion: "failure",
            attempt: 1,
          }),
        ],
      },
    ],
    80,
  );

  assertSnapshot("pr-status-failed-ci-reruns", output);
});

test("pr-status: PR with in-progress CI", () => {
  const output = renderPRStatusOutput(
    "acme/widgets",
    [
      {
        pr: {
          number: 55,
          headRefName: "cursor/refactor-api",
          title: "Refactor API layer",
        },
        runs: [
          makeWorkflowRun({
            databaseId: 3001,
            name: "Build",
            conclusion: "",
            status: "in_progress",
          }),
          makeWorkflowRun({
            databaseId: 3002,
            name: "Tests",
            conclusion: "",
            status: "queued",
          }),
        ],
      },
    ],
    80,
  );

  assertSnapshot("pr-status-in-progress", output);
});

test("pr-status: PR with no workflow runs", () => {
  const output = renderPRStatusOutput(
    "acme/widgets",
    [
      {
        pr: {
          number: 10,
          headRefName: "claude/docs-update",
          title: "Update README",
        },
        runs: [],
      },
    ],
    80,
  );

  assertSnapshot("pr-status-no-runs", output);
});

test("pr-status: multiple PRs with mixed statuses", () => {
  const output = renderPRStatusOutput(
    "acme/widgets",
    [
      {
        pr: {
          number: 42,
          headRefName: "cursor/fix-login",
          title: "Fix login flow",
        },
        runs: [makeWorkflowRun({ conclusion: "success" })],
      },
      {
        pr: {
          number: 43,
          headRefName: "claude/add-cache",
          title: "Add Redis caching layer",
        },
        runs: [
          makeWorkflowRun({
            databaseId: 4001,
            name: "CI",
            conclusion: "failure",
            attempt: 1,
          }),
        ],
      },
      {
        pr: {
          number: 44,
          headRefName: "cursor/ui-tweaks",
          title: "Minor UI adjustments",
        },
        runs: [],
      },
    ],
    80,
  );

  assertSnapshot("pr-status-multiple-prs", output);
});

test("pr-status: long title truncation at narrow width", () => {
  const longTitle =
    "This is an extremely long pull request title that should be truncated when rendered in a narrow terminal width";
  const output = renderPRStatusOutput(
    "acme/widgets",
    [
      {
        pr: {
          number: 77,
          headRefName: "cursor/long-title",
          title: longTitle,
        },
        runs: [makeWorkflowRun({ conclusion: "success" })],
      },
    ],
    60,
  );

  assertSnapshot("pr-status-long-title-truncation", output);
});

// ---------------------------------------------------------------------------
// Tests: formatCommentBody (lib/format.ts)
// ---------------------------------------------------------------------------

test("formatCommentBody: strips HTML and styles markdown", () => {
  const body = `### Review Summary

**High Severity** issue found in \`auth.ts\`.

Check the details below.`;

  const output = formatCommentBody(body);
  assertSnapshot("format-comment-body", output);
});

test("formatCommentBody: handles empty body", () => {
  const output = formatCommentBody("");
  assertSnapshot("format-comment-body-empty", output);
});

test("formatCommentBody: strips HTML comments", () => {
  const body = `<!-- hidden comment -->Visible text<!-- another -->`;
  const output = formatCommentBody(body);
  assertSnapshot("format-comment-body-html-comments", output);
});

test("formatCommentBody: expands details/summary tags", () => {
  const body = `<details><summary>Click to expand</summary>

Hidden content here.

</details>`;
  const output = formatCommentBody(body);
  assertSnapshot("format-comment-body-details", output);
});

// ---------------------------------------------------------------------------
// Tests: wrapAnsiText (lib/format.ts)
// ---------------------------------------------------------------------------

test("wrapAnsiText: wraps long lines with indent", () => {
  const longLine =
    "This is a very long line that should be wrapped when it exceeds the maximum column width of the terminal";
  const wrapped = wrapAnsiText(longLine, 40, "  ");
  const output = wrapped.join("\n");
  assertSnapshot("wrap-ansi-text", output);
});

test("wrapAnsiText: preserves ANSI codes across wraps", () => {
  const ansiLine = `${ANSI.bold}Bold text that goes on${ANSI.reset} and ${ANSI.red}red text continues${ANSI.reset} for a while`;
  const wrapped = wrapAnsiText(ansiLine, 30, "");
  const output = wrapped.join("\n");
  assertSnapshot("wrap-ansi-preserves-codes", output);
});

test("wrapAnsiText: handles empty lines", () => {
  const text = "first\n\nsecond";
  const wrapped = wrapAnsiText(text, 40, ">> ");
  const output = wrapped.join("\n");
  assertSnapshot("wrap-ansi-empty-lines", output);
});

test("wrapAnsiText: short lines stay intact", () => {
  const text = "short";
  const wrapped = wrapAnsiText(text, 80, "  ");
  const output = wrapped.join("\n");
  assertSnapshot("wrap-ansi-short-line", output);
});
