import test from "node:test";
import assert from "node:assert/strict";

import {
  parseStandardFlags,
  parseHoursOption,
  parseBaseOption,
  parseTemplateOption,
  parseTemplatesOption,
  calculateSinceDate,
} from "../lib/args.js";

// -- parseStandardFlags --

test("parseStandardFlags defaults to mineOnly when --all is absent", () => {
  const { flags } = parseStandardFlags(["owner/repo"]);
  assert.equal(flags.mineOnly, true);
  assert.equal(flags.all, false);
  assert.equal(flags.dryRun, false);
});

test("parseStandardFlags detects --all flag", () => {
  const { flags } = parseStandardFlags(["--all", "owner/repo"]);
  assert.equal(flags.all, true);
  assert.equal(flags.mineOnly, false);
});

test("parseStandardFlags detects --dry-run flag", () => {
  const { flags } = parseStandardFlags(["--dry-run"]);
  assert.equal(flags.dryRun, true);
});

test("parseStandardFlags strips known flags from filtered output", () => {
  const { filtered } = parseStandardFlags(["--dry-run", "--all", "--mine", "owner/repo", "cursor"]);
  assert.deepEqual(filtered, ["owner/repo", "cursor"]);
});

test("parseStandardFlags strips --templates and its value", () => {
  const { filtered } = parseStandardFlags(["--templates", "/path/to/templates", "owner/repo"]);
  assert.deepEqual(filtered, ["owner/repo"]);
});

// -- parseHoursOption --

test("parseHoursOption returns parsed hours value", () => {
  assert.equal(parseHoursOption(["--hours", "48"], 0), 48);
});

test("parseHoursOption throws when value is missing", () => {
  assert.throws(() => parseHoursOption(["--hours"], 0), /--hours requires a value/);
});

test("parseHoursOption throws for non-positive values", () => {
  assert.throws(() => parseHoursOption(["--hours", "0"], 0), /--hours must be a positive number/);
  assert.throws(() => parseHoursOption(["--hours", "-5"], 0), /--hours must be a positive number/);
});

test("parseHoursOption throws for non-numeric values", () => {
  assert.throws(() => parseHoursOption(["--hours", "abc"], 0), /--hours must be a positive number/);
});

// -- parseBaseOption --

test("parseBaseOption returns base branch value", () => {
  assert.equal(parseBaseOption(["--base", "develop"], 0), "develop");
});

test("parseBaseOption throws when value is missing", () => {
  assert.throws(() => parseBaseOption(["--base"], 0), /--base requires a value/);
});

// -- parseTemplateOption --

test("parseTemplateOption returns template value", () => {
  assert.equal(parseTemplateOption(["--template", "my-template"], 0), "my-template");
});

test("parseTemplateOption throws when value is missing", () => {
  assert.throws(() => parseTemplateOption(["--template"], 0), /--template requires a value/);
});

// -- parseTemplatesOption --

test("parseTemplatesOption returns null when not present", () => {
  assert.equal(parseTemplatesOption(["owner/repo"]), null);
});

test("parseTemplatesOption returns path when present", () => {
  assert.equal(parseTemplatesOption(["--templates", "/my/path"]), "/my/path");
});

test("parseTemplatesOption throws when value is missing", () => {
  assert.throws(() => parseTemplatesOption(["--templates"]), /--templates requires a value/);
});

test("parseTemplatesOption throws when value looks like another flag", () => {
  assert.throws(() => parseTemplatesOption(["--templates", "--other"]), /--templates requires a value/);
});

// -- calculateSinceDate --

test("calculateSinceDate returns a date in the past", () => {
  const before = Date.now();
  const since = calculateSinceDate(24);
  const after = Date.now();

  const expectedMin = before - 24 * 60 * 60 * 1000;
  const expectedMax = after - 24 * 60 * 60 * 1000;

  assert.ok(since.getTime() >= expectedMin);
  assert.ok(since.getTime() <= expectedMax);
});

test("calculateSinceDate with 0 hours returns approximately now", () => {
  const now = Date.now();
  const since = calculateSinceDate(0);
  assert.ok(Math.abs(since.getTime() - now) < 100);
});
