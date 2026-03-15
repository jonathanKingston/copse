import test from "node:test";
import assert from "node:assert/strict";

import { formatBytes, formatCommentBody, wrapAnsiText } from "../lib/format.js";

// -- formatBytes --

test("formatBytes formats zero bytes", () => {
  assert.equal(formatBytes(0), "0B");
});

test("formatBytes formats small byte values", () => {
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(1023), "1023B");
});

test("formatBytes formats kilobytes", () => {
  assert.equal(formatBytes(1024), "1.0KB");
  assert.equal(formatBytes(1536), "1.5KB");
  assert.equal(formatBytes(10240), "10KB");
});

test("formatBytes formats megabytes", () => {
  assert.equal(formatBytes(1048576), "1.0MB");
  assert.equal(formatBytes(5242880), "5.0MB");
});

test("formatBytes formats gigabytes", () => {
  assert.equal(formatBytes(1073741824), "1.0GB");
});

test("formatBytes returns ? for null/undefined/NaN", () => {
  assert.equal(formatBytes(null), "?");
  assert.equal(formatBytes(undefined), "?");
  assert.equal(formatBytes(NaN), "?");
});

test("formatBytes returns ? for negative values", () => {
  assert.equal(formatBytes(-1), "?");
});

// -- formatCommentBody --

test("formatCommentBody strips HTML comments", () => {
  const result = formatCommentBody("hello <!-- secret --> world");
  assert.ok(!result.includes("secret"));
  assert.ok(result.includes("hello"));
  assert.ok(result.includes("world"));
});

test("formatCommentBody strips HTML tags", () => {
  const result = formatCommentBody("<p>paragraph</p>");
  assert.ok(result.includes("paragraph"));
  assert.ok(!result.includes("<p>"));
});

test("formatCommentBody decodes HTML entities", () => {
  const result = formatCommentBody("a &amp; b &lt; c &gt; d");
  assert.ok(result.includes("a & b < c > d"));
});

test("formatCommentBody handles bold markdown", () => {
  const result = formatCommentBody("**important**");
  assert.ok(result.includes("important"));
});

test("formatCommentBody handles inline code", () => {
  const result = formatCommentBody("`code here`");
  assert.ok(result.includes("code here"));
});

test("formatCommentBody collapses excessive newlines", () => {
  const result = formatCommentBody("a\n\n\n\n\nb");
  assert.ok(!result.includes("\n\n\n"));
});

test("formatCommentBody extracts Cursor URLs as actions", () => {
  const body = '<a href="https://cursor.com/open?foo=bar">Open</a>';
  const result = formatCommentBody(body);
  assert.ok(result.includes("Fix in Cursor"));
});

test("formatCommentBody handles details/summary elements", () => {
  const result = formatCommentBody("<details><summary>Click me</summary> Hidden content</details>");
  assert.ok(result.includes("Click me"));
});

// -- wrapAnsiText --

test("wrapAnsiText wraps long lines at width", () => {
  const lines = wrapAnsiText("abcdefghij", 5);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "abcde");
  assert.equal(lines[1], "fghij");
});

test("wrapAnsiText preserves short lines", () => {
  const lines = wrapAnsiText("short", 80);
  assert.deepEqual(lines, ["short"]);
});

test("wrapAnsiText handles empty lines", () => {
  const lines = wrapAnsiText("a\n\nb", 80);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "");
});

test("wrapAnsiText applies indent prefix", () => {
  const lines = wrapAnsiText("hello world", 80, "  ");
  assert.equal(lines[0], "  hello world");
});

test("wrapAnsiText preserves ANSI escape codes without counting them in width", () => {
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const text = `${bold}hi${reset}`;
  const lines = wrapAnsiText(text, 5);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(bold));
});

test("wrapAnsiText handles multiline input", () => {
  const lines = wrapAnsiText("line1\nline2\nline3", 80);
  assert.equal(lines.length, 3);
});

test("wrapAnsiText handles width of 1", () => {
  const lines = wrapAnsiText("abc", 1);
  assert.equal(lines.length, 3);
});
