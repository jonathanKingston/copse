import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  expandTildePath,
  getDefaultTemplatesDir,
  scaffoldTemplates,
  loadTemplates,
  resolveTemplatesPath,
  needsScaffold,
} from "../lib/templates.js";
import { setApiProvider, resetApiProvider } from "../lib/api-provider.js";

// -- expandTildePath --

test("expandTildePath expands ~ to homedir", () => {
  const result = expandTildePath("~/my-templates");
  assert.ok(!result.startsWith("~"));
  assert.ok(result.endsWith("/my-templates"));
});

test("expandTildePath expands bare ~", () => {
  const result = expandTildePath("~");
  assert.ok(!result.startsWith("~"));
  assert.ok(result.length > 1);
});

test("expandTildePath leaves absolute paths unchanged", () => {
  assert.equal(expandTildePath("/absolute/path"), "/absolute/path");
});

test("expandTildePath leaves relative paths unchanged", () => {
  assert.equal(expandTildePath("relative/path"), "relative/path");
});

// -- getDefaultTemplatesDir --

test("getDefaultTemplatesDir returns a path under home", () => {
  const result = getDefaultTemplatesDir();
  assert.ok(result.includes(".copse/comment-templates"));
});

// -- scaffoldTemplates --

test("scaffoldTemplates creates directory and starter files", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "copse-test-"));
  const templatesDir = join(tmpDir, "templates");

  try {
    scaffoldTemplates(templatesDir);

    assert.ok(existsSync(templatesDir));
    assert.ok(existsSync(join(templatesDir, "please-fix.md")));
    assert.ok(existsSync(join(templatesDir, "add-tests.md")));
    assert.ok(existsSync(join(templatesDir, "review-again.md")));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -- loadTemplates (without mock provider) --

test("loadTemplates returns empty map for non-existent directory", () => {
  resetApiProvider();
  const result = loadTemplates("/non/existent/path/templates");
  assert.equal(result.size, 0);
});

test("loadTemplates loads .md files from directory", () => {
  resetApiProvider();
  const tmpDir = mkdtempSync(join(tmpdir(), "copse-test-"));

  try {
    writeFileSync(join(tmpDir, "fix-bug.md"), "Please fix this bug");
    writeFileSync(join(tmpDir, "add-feature.md"), "Please add this feature");
    writeFileSync(join(tmpDir, "not-markdown.txt"), "Should be ignored");

    const result = loadTemplates(tmpDir);
    assert.equal(result.size, 2);
    assert.equal(result.get("fix-bug"), "Please fix this bug");
    assert.equal(result.get("add-feature"), "Please add this feature");
    assert.ok(!result.has("not-markdown"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadTemplates strips .md extension from labels", () => {
  resetApiProvider();
  const tmpDir = mkdtempSync(join(tmpdir(), "copse-test-"));

  try {
    writeFileSync(join(tmpDir, "my-template.md"), "body");
    const result = loadTemplates(tmpDir);
    assert.ok(result.has("my-template"));
    assert.ok(!result.has("my-template.md"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -- resolveTemplatesPath --

test("resolveTemplatesPath prefers flag over config", () => {
  const result = resolveTemplatesPath("/from/flag", "/from/config");
  assert.equal(result, "/from/flag");
});

test("resolveTemplatesPath falls back to config when no flag", () => {
  const result = resolveTemplatesPath(null, "/from/config");
  assert.equal(result, "/from/config");
});

test("resolveTemplatesPath falls back to default when neither given", () => {
  const result = resolveTemplatesPath(null, null);
  assert.ok(result.includes(".copse/comment-templates"));
});

test("resolveTemplatesPath expands tilde in flag", () => {
  const result = resolveTemplatesPath("~/my-templates", null);
  assert.ok(!result.startsWith("~"));
});

// -- needsScaffold --

test("needsScaffold returns true for missing directory", () => {
  assert.ok(needsScaffold("/non/existent/path"));
});

test("needsScaffold returns true for empty directory", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "copse-test-"));
  try {
    assert.ok(needsScaffold(tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("needsScaffold returns true for directory with no .md files", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "copse-test-"));
  try {
    writeFileSync(join(tmpDir, "readme.txt"), "not markdown");
    assert.ok(needsScaffold(tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("needsScaffold returns false when .md files exist", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "copse-test-"));
  try {
    writeFileSync(join(tmpDir, "template.md"), "body");
    assert.ok(!needsScaffold(tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
