import test from "node:test";
import assert from "node:assert/strict";

import { formatBytes, formatCommentBody, wrapAnsiText } from "../lib/format.js";

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;

/** Strip all ANSI SGR and OSC 8 sequences from a string. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");
}

// ── formatBytes ──────────────────────────────────────────────────────────────

test("formatBytes returns '?' for null, undefined, NaN, and negative values", () => {
  assert.equal(formatBytes(null), "?");
  assert.equal(formatBytes(undefined), "?");
  assert.equal(formatBytes(NaN), "?");
  assert.equal(formatBytes(-1), "?");
  assert.equal(formatBytes(-100), "?");
});

test("formatBytes formats 0 bytes", () => {
  assert.equal(formatBytes(0), "0B");
});

test("formatBytes formats bytes below 1 KB without decimals", () => {
  assert.equal(formatBytes(1), "1B");
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(1023), "1023B");
});

test("formatBytes formats kilobytes", () => {
  assert.equal(formatBytes(1024), "1.0KB");
  assert.equal(formatBytes(1536), "1.5KB");
  assert.equal(formatBytes(10240), "10KB");
});

test("formatBytes formats megabytes", () => {
  assert.equal(formatBytes(1024 * 1024), "1.0MB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0MB");
  assert.equal(formatBytes(15 * 1024 * 1024), "15MB");
});

test("formatBytes formats gigabytes", () => {
  assert.equal(formatBytes(1024 ** 3), "1.0GB");
});

test("formatBytes formats terabytes and petabytes", () => {
  assert.equal(formatBytes(1024 ** 4), "1.0TB");
  assert.equal(formatBytes(1024 ** 5), "1.0PB");
});

test("formatBytes clamps at PB unit for very large values", () => {
  const result = formatBytes(1024 ** 6);
  assert.ok(result.endsWith("PB"), `Expected PB suffix, got: ${result}`);
});

// ── wrapAnsiText ─────────────────────────────────────────────────────────────

test("wrapAnsiText returns single line when text fits within width", () => {
  const result = wrapAnsiText("hello world", 80);
  assert.deepStrictEqual(result, ["hello world"]);
});

test("wrapAnsiText wraps long lines at width boundary", () => {
  const text = "abcdefghij"; // 10 chars
  const result = wrapAnsiText(text, 5);
  assert.deepStrictEqual(result, ["abcde", "fghij"]);
});

test("wrapAnsiText handles empty string", () => {
  const result = wrapAnsiText("", 80);
  assert.deepStrictEqual(result, [""]);
});

test("wrapAnsiText preserves multiple newlines as blank indented lines", () => {
  const result = wrapAnsiText("a\n\nb", 80);
  assert.equal(result.length, 3);
  assert.equal(result[0], "a");
  assert.equal(result[1], ""); // empty line gets indent (empty indent)
  assert.equal(result[2], "b");
});

test("wrapAnsiText applies indent prefix", () => {
  const result = wrapAnsiText("hello", 80, "  ");
  assert.deepStrictEqual(result, ["  hello"]);
});

test("wrapAnsiText accounts for indent in effective width", () => {
  const text = "abcdefghij"; // 10 visible chars
  // width=7, indent="  " (2 chars) -> effective width = 5
  const result = wrapAnsiText(text, 7, "  ");
  assert.deepStrictEqual(result, ["  abcde", "  fghij"]);
});

test("wrapAnsiText preserves ANSI SGR codes without counting them as width", () => {
  const text = `${BOLD}hello${RESET}`;
  // visible length is 5 ("hello"), total string is longer due to escapes
  const result = wrapAnsiText(text, 80);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes(BOLD));
  assert.ok(result[0].includes(RESET));
  assert.equal(stripAnsi(result[0]), "hello");
});

test("wrapAnsiText wraps text with ANSI codes correctly", () => {
  // "abcde" in bold + "fghij" plain = 10 visible chars, width 5
  const text = `${BOLD}abcde${RESET}fghij`;
  const result = wrapAnsiText(text, 5);
  // Should split at 5 visible chars
  const allText = result.map(stripAnsi).join("");
  assert.equal(allText, "abcdefghij");
  assert.equal(result.length, 2);
});

test("wrapAnsiText handles OSC 8 hyperlink sequences", () => {
  const link = `${ESC}]8;;https://example.com\x07click${ESC}]8;;\x07`;
  const result = wrapAnsiText(link, 80);
  assert.equal(result.length, 1);
  // visible text is just "click" (5 chars)
  assert.equal(stripAnsi(result[0]), "click");
});

test("wrapAnsiText with effectiveWidth clamped to 1 for very small widths", () => {
  const result = wrapAnsiText("ab", 0);
  // effectiveWidth = max(1, 0 - 0) = 1
  assert.deepStrictEqual(result, ["a", "b"]);
});

test("wrapAnsiText handles nested ANSI codes across wrap boundary", () => {
  // Bold + red text that needs wrapping
  const text = `${BOLD}${RED}abcde${RESET}`;
  const result = wrapAnsiText(text, 3);
  const allVisible = result.map(stripAnsi).join("");
  assert.equal(allVisible, "abcde");
});

// ── formatCommentBody ────────────────────────────────────────────────────────

test("formatCommentBody strips HTML comments", () => {
  const result = formatCommentBody("hello <!-- hidden --> world");
  assert.equal(stripAnsi(result), "hello  world");
});

test("formatCommentBody strips remaining HTML tags", () => {
  const result = formatCommentBody("<p>hello</p> <br/> world");
  assert.equal(stripAnsi(result), "hello  world");
});

test("formatCommentBody decodes HTML entities", () => {
  const result = formatCommentBody("a &amp; b &lt; c &gt; d &nbsp; e");
  assert.equal(stripAnsi(result), "a & b < c > d   e");
});

test("formatCommentBody styles ### headings with bold", () => {
  const result = formatCommentBody("### My Heading");
  assert.ok(result.includes(BOLD));
  assert.ok(stripAnsi(result).includes("My Heading"));
});

test("formatCommentBody styles **bold** text", () => {
  const result = formatCommentBody("some **important** text");
  assert.ok(result.includes(BOLD));
  assert.ok(stripAnsi(result).includes("important"));
});

test("formatCommentBody styles `code` with dim", () => {
  const result = formatCommentBody("run `npm test` now");
  assert.ok(result.includes(DIM));
  assert.ok(stripAnsi(result).includes("npm test"));
});

test("formatCommentBody applies red to High Severity in bold", () => {
  const result = formatCommentBody("**High Severity**");
  assert.ok(result.includes(RED));
  assert.ok(stripAnsi(result).includes("High Severity"));
});

test("formatCommentBody applies yellow to Medium Severity in bold", () => {
  const result = formatCommentBody("**Medium Severity**");
  assert.ok(result.includes(YELLOW));
  assert.ok(stripAnsi(result).includes("Medium Severity"));
});

test("formatCommentBody applies dim to Low Severity in bold", () => {
  const result = formatCommentBody("**Low Severity**");
  assert.ok(result.includes(DIM));
  assert.ok(stripAnsi(result).includes("Low Severity"));
});

test("formatCommentBody applies color to severity markdown links", () => {
  const result = formatCommentBody("[High Severity](https://example.com)");
  assert.ok(result.includes(RED));
  assert.ok(stripAnsi(result).includes("High Severity"));
});

test("formatCommentBody collapses 3+ consecutive newlines to 2", () => {
  const result = formatCommentBody("a\n\n\n\nb");
  assert.ok(!result.includes("\n\n\n"));
  assert.ok(stripAnsi(result).includes("a\n\nb"));
});

test("formatCommentBody handles <details>/<summary> blocks", () => {
  const html = "<details>\n<summary>Click me</summary>\nContent here\n</details>";
  const result = formatCommentBody(html);
  assert.ok(stripAnsi(result).includes("Click me"));
  assert.ok(stripAnsi(result).includes("Content here"));
});

test("formatCommentBody handles empty string", () => {
  const result = formatCommentBody("");
  assert.equal(result, "");
});

test("formatCommentBody handles plain text without markdown", () => {
  const result = formatCommentBody("just plain text");
  assert.equal(stripAnsi(result), "just plain text");
});

test("formatCommentBody strips cursor.com/open links and adds action section", () => {
  const body = `Review <a href="https://cursor.com/open?foo=bar">Open in Cursor</a> done`;
  const result = formatCommentBody(body);
  // The link text should be removed from the body
  assert.ok(!stripAnsi(result).includes("Open in Cursor"));
  // An Actions section should appear with the link
  assert.ok(stripAnsi(result).includes("Actions:"));
  assert.ok(stripAnsi(result).includes("Fix in Cursor"));
});

test("formatCommentBody strips cursor.com/agents links and adds action section", () => {
  const body = `Review <a href="https://cursor.com/agents?foo=bar">Open Web</a> done`;
  const result = formatCommentBody(body);
  assert.ok(!stripAnsi(result).includes("Open Web"));
  assert.ok(stripAnsi(result).includes("Fix in Web"));
});

// ── stripAnsi helper (internal consistency) ──────────────────────────────────

test("stripAnsi removes SGR sequences", () => {
  assert.equal(stripAnsi(`${BOLD}hello${RESET}`), "hello");
  assert.equal(stripAnsi(`${RED}${BOLD}nested${RESET}`), "nested");
});

test("stripAnsi removes OSC 8 hyperlink sequences", () => {
  const link = `${ESC}]8;;https://example.com\x07text${ESC}]8;;\x07`;
  assert.equal(stripAnsi(link), "text");
});

test("stripAnsi returns plain text unchanged", () => {
  assert.equal(stripAnsi("plain text"), "plain text");
  assert.equal(stripAnsi(""), "");
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test("wrapAnsiText handles very long string without spaces", () => {
  const long = "x".repeat(200);
  const result = wrapAnsiText(long, 50);
  assert.equal(result.length, 4);
  assert.ok(result.every((line) => stripAnsi(line).length === 50));
});

test("formatCommentBody handles string with only ANSI-triggering markdown", () => {
  const result = formatCommentBody("**bold** `code` ### heading");
  // Should not throw and should contain styled text
  assert.ok(result.length > 0);
  assert.ok(stripAnsi(result).includes("bold"));
  assert.ok(stripAnsi(result).includes("code"));
});

test("formatCommentBody handles multiple severity levels in same body", () => {
  const body = "**High Severity** issue and **Low Severity** note";
  const result = formatCommentBody(body);
  assert.ok(result.includes(RED));
  assert.ok(result.includes(DIM));
  assert.ok(stripAnsi(result).includes("High Severity"));
  assert.ok(stripAnsi(result).includes("Low Severity"));
});

test("wrapAnsiText multiline input with mixed widths", () => {
  const text = "short\nthis line is much longer than ten";
  const result = wrapAnsiText(text, 10);
  assert.equal(result[0], "short");
  // remaining lines should each be <= 10 visible chars
  for (const line of result) {
    assert.ok(stripAnsi(line).length <= 10, `Line too long: "${line}"`);
  }
});
