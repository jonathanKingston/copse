import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  getUrgency,
  matchesSearch,
  ANSI,
  visibleLength,
  pad,
  truncatePlain,
  formatCI,
  formatReview,
  formatAutoMerge,
  formatComments,
  formatDiffFileRow,
  highlightRow,
} from "../lib/status-helpers.js";
import type { PRWithStatus } from "../lib/services/status-types.js";
import type { PRChangedFile } from "../lib/types.js";

function makePR(overrides: Partial<PRWithStatus> = {}): PRWithStatus {
  return {
    rowType: "pr",
    repo: "acme/widget",
    number: 42,
    headRefName: "feature-branch",
    baseRefName: "main",
    title: "Add widget support",
    author: { login: "alice" },
    labels: [],
    isDraft: false,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: "",
    autoMerge: false,
    conflicts: false,
    readyToMerge: false,
    commentCount: 0,
    updatedAt: "2026-03-15T00:00:00Z",
    agent: "cursor",
    ciStatus: "pass",
    ageDays: 1,
    stale: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getUrgency
// ---------------------------------------------------------------------------

describe("getUrgency", () => {
  test("returns red when CI fails", () => {
    assert.equal(getUrgency(makePR({ ciStatus: "fail" })), "red");
  });

  test("returns red when PR has conflicts", () => {
    assert.equal(getUrgency(makePR({ conflicts: true })), "red");
  });

  test("returns red when CI fails AND conflicts exist", () => {
    assert.equal(getUrgency(makePR({ ciStatus: "fail", conflicts: true })), "red");
  });

  test("returns amber when stale", () => {
    assert.equal(getUrgency(makePR({ stale: true })), "amber");
  });

  test("returns amber when changes requested", () => {
    assert.equal(getUrgency(makePR({ reviewDecision: "CHANGES_REQUESTED" })), "amber");
  });

  test("returns amber when CI is pending", () => {
    assert.equal(getUrgency(makePR({ ciStatus: "pending" })), "amber");
  });

  test("returns green for a healthy PR", () => {
    assert.equal(getUrgency(makePR()), "green");
  });

  test("red takes priority over amber conditions", () => {
    assert.equal(getUrgency(makePR({ ciStatus: "fail", stale: true })), "red");
  });
});

// ---------------------------------------------------------------------------
// matchesSearch
// ---------------------------------------------------------------------------

describe("matchesSearch", () => {
  test("empty query matches everything", () => {
    assert.equal(matchesSearch(makePR(), ""), true);
  });

  test("matches repo name", () => {
    assert.equal(matchesSearch(makePR(), "acme"), true);
  });

  test("matches PR number", () => {
    assert.equal(matchesSearch(makePR({ number: 123 }), "123"), true);
  });

  test("matches agent name", () => {
    assert.equal(matchesSearch(makePR({ agent: "claude" }), "claude"), true);
  });

  test("matches CI status", () => {
    assert.equal(matchesSearch(makePR({ ciStatus: "fail" }), "fail"), true);
  });

  test("matches review decision with spaces instead of underscores", () => {
    assert.equal(matchesSearch(makePR({ reviewDecision: "CHANGES_REQUESTED" }), "changes requested"), true);
  });

  test("matches conflicts keyword when PR has conflicts", () => {
    assert.equal(matchesSearch(makePR({ conflicts: true }), "conflicts"), true);
  });

  test("does not match conflicts keyword when no conflicts", () => {
    // conflicts: false produces empty string, which won't match "conflicts"
    assert.equal(matchesSearch(makePR({ conflicts: false }), "conflicts"), false);
  });

  test("matches auto-merge keyword", () => {
    assert.equal(matchesSearch(makePR({ autoMerge: true }), "merge when ready"), true);
  });

  test("matches age string", () => {
    assert.equal(matchesSearch(makePR({ ageDays: 5 }), "5d"), true);
  });

  test("matches title", () => {
    assert.equal(matchesSearch(makePR({ title: "Fix login bug" }), "login"), true);
  });

  test("matches author login", () => {
    assert.equal(matchesSearch(makePR({ author: { login: "bob" } }), "bob"), true);
  });

  test("matches branch name", () => {
    assert.equal(matchesSearch(makePR({ headRefName: "fix/auth-issue" }), "auth"), true);
  });

  test("search is case-insensitive", () => {
    assert.equal(matchesSearch(makePR({ title: "Fix Auth" }), "fix auth"), true);
  });

  test("returns false for non-matching query", () => {
    assert.equal(matchesSearch(makePR(), "nonexistent-term-xyz"), false);
  });
});

// ---------------------------------------------------------------------------
// visibleLength
// ---------------------------------------------------------------------------

describe("visibleLength", () => {
  test("returns length of plain text", () => {
    assert.equal(visibleLength("hello"), 5);
  });

  test("strips ANSI color codes", () => {
    assert.equal(visibleLength(`${ANSI.red}error${ANSI.reset}`), 5);
  });

  test("strips hyperlink sequences", () => {
    const link = `\x1b]8;;https://example.com\x07click\x1b]8;;\x07`;
    assert.equal(visibleLength(link), 5);
  });

  test("returns 0 for empty string", () => {
    assert.equal(visibleLength(""), 0);
  });
});

// ---------------------------------------------------------------------------
// pad
// ---------------------------------------------------------------------------

describe("pad", () => {
  test("pads plain text to width", () => {
    assert.equal(pad("hi", 5), "hi   ");
  });

  test("does not pad when text already meets width", () => {
    assert.equal(pad("hello", 5), "hello");
  });

  test("does not truncate when text exceeds width", () => {
    assert.equal(pad("hello!", 3), "hello!");
  });

  test("pads text with ANSI codes based on visible length", () => {
    const colored = `${ANSI.red}hi${ANSI.reset}`;
    const padded = pad(colored, 5);
    assert.equal(visibleLength(padded), 5);
    assert.ok(padded.startsWith(colored));
  });
});

// ---------------------------------------------------------------------------
// truncatePlain
// ---------------------------------------------------------------------------

describe("truncatePlain", () => {
  test("returns text unchanged if within limit", () => {
    assert.equal(truncatePlain("abc", 5), "abc");
  });

  test("truncates with ellipsis when exceeding limit", () => {
    assert.equal(truncatePlain("abcdef", 4), "abc\u2026");
  });

  test("returns empty string for maxLen 0", () => {
    assert.equal(truncatePlain("abc", 0), "");
  });

  test("returns empty string for negative maxLen", () => {
    assert.equal(truncatePlain("abc", -1), "");
  });

  test("returns just ellipsis for maxLen 1", () => {
    assert.equal(truncatePlain("abc", 1), "\u2026");
  });

  test("returns text unchanged when exactly at limit", () => {
    assert.equal(truncatePlain("abc", 3), "abc");
  });
});

// ---------------------------------------------------------------------------
// formatCI
// ---------------------------------------------------------------------------

describe("formatCI", () => {
  test("pass shows green check", () => {
    const result = formatCI(makePR({ ciStatus: "pass" }));
    assert.ok(result.includes(ANSI.green));
    assert.ok(result.includes("\u2713"));
  });

  test("fail shows red cross", () => {
    const result = formatCI(makePR({ ciStatus: "fail" }));
    assert.ok(result.includes(ANSI.red));
    assert.ok(result.includes("\u2717"));
  });

  test("pending shows amber ellipsis", () => {
    const result = formatCI(makePR({ ciStatus: "pending" }));
    assert.ok(result.includes(ANSI.amber));
  });

  test("none shows dim dash", () => {
    const result = formatCI(makePR({ ciStatus: "none" }));
    assert.ok(result.includes(ANSI.dim));
  });
});

// ---------------------------------------------------------------------------
// formatReview
// ---------------------------------------------------------------------------

describe("formatReview", () => {
  test("APPROVED shows green check", () => {
    const result = formatReview(makePR({ reviewDecision: "APPROVED" }));
    assert.ok(result.includes(ANSI.green));
    assert.ok(result.includes("\u2713"));
  });

  test("CHANGES_REQUESTED shows amber exclamation", () => {
    const result = formatReview(makePR({ reviewDecision: "CHANGES_REQUESTED" }));
    assert.ok(result.includes(ANSI.amber));
    assert.ok(result.includes("!"));
  });

  test("empty review shows dim circle", () => {
    const result = formatReview(makePR({ reviewDecision: "" }));
    assert.ok(result.includes(ANSI.dim));
  });
});

// ---------------------------------------------------------------------------
// formatAutoMerge
// ---------------------------------------------------------------------------

describe("formatAutoMerge", () => {
  test("enabled shows green check", () => {
    const result = formatAutoMerge(makePR({ autoMerge: true }));
    assert.ok(result.includes(ANSI.green));
  });

  test("disabled shows dim dash", () => {
    const result = formatAutoMerge(makePR({ autoMerge: false }));
    assert.ok(result.includes(ANSI.dim));
  });
});

// ---------------------------------------------------------------------------
// formatComments
// ---------------------------------------------------------------------------

describe("formatComments", () => {
  test("zero comments shows dim dash", () => {
    const result = formatComments(makePR({ commentCount: 0 }));
    assert.ok(result.includes(ANSI.dim));
  });

  test("non-zero comments shows amber count", () => {
    const result = formatComments(makePR({ commentCount: 3 }));
    assert.ok(result.includes(ANSI.amber));
    assert.ok(result.includes("3"));
  });
});

// ---------------------------------------------------------------------------
// formatDiffFileRow
// ---------------------------------------------------------------------------

describe("formatDiffFileRow", () => {
  function makeFile(overrides: Partial<PRChangedFile> = {}): PRChangedFile {
    return {
      sha: "abc123",
      filename: "src/index.ts",
      status: "modified",
      additions: 10,
      deletions: 5,
      changes: 15,
      ...overrides,
    };
  }

  test("modified file shows M with amber color", () => {
    const row = formatDiffFileRow(makeFile());
    assert.ok(row.includes(`${ANSI.amber}M${ANSI.reset}`));
    assert.ok(row.includes("src/index.ts"));
    assert.ok(row.includes("+10"));
    assert.ok(row.includes("-5"));
  });

  test("added file shows A with green color", () => {
    const row = formatDiffFileRow(makeFile({ status: "added" }));
    assert.ok(row.includes(`${ANSI.green}A${ANSI.reset}`));
  });

  test("removed file shows D with red color", () => {
    const row = formatDiffFileRow(makeFile({ status: "removed" }));
    assert.ok(row.includes(`${ANSI.red}D${ANSI.reset}`));
  });

  test("renamed file shows R with arrow between names", () => {
    const row = formatDiffFileRow(makeFile({
      status: "renamed",
      filename: "new.ts",
      previous_filename: "old.ts",
    }));
    assert.ok(row.includes("R"));
    assert.ok(row.includes("old.ts \u2192 new.ts"));
  });
});

// ---------------------------------------------------------------------------
// highlightRow
// ---------------------------------------------------------------------------

describe("highlightRow", () => {
  test("wraps row in reverse video", () => {
    const row = "plain text";
    const result = highlightRow(row);
    assert.ok(result.startsWith("\x1b[7m"));
    assert.ok(result.endsWith("\x1b[0m"));
  });

  test("re-enables reverse video after reset codes", () => {
    const row = `${ANSI.red}text${ANSI.reset} more`;
    const result = highlightRow(row);
    assert.ok(result.includes("\x1b[0m\x1b[7m"));
  });
});
