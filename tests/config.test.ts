import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

import { loadConfig, getCommentTemplates, getConfiguredRepos } from "../lib/config.js";

const TEMPLATES_DIR = join(homedir(), ".copse", "comment-templates");

function makeTempDir(): string {
  const dir = join(tmpdir(), `copse-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, config: object): void {
  writeFileSync(join(dir, ".copserc"), JSON.stringify(config, null, 2));
}

function writeTemplate(filename: string, label: string, message: string): void {
  mkdirSync(TEMPLATES_DIR, { recursive: true });
  const content = `---\nlabel: ${label}\n---\n${message}`;
  writeFileSync(join(TEMPLATES_DIR, filename), content);
}

function cleanupTemplates(): void {
  try {
    rmSync(TEMPLATES_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

test("loadConfig returns null when no .copserc exists", () => {
  const dir = makeTempDir();
  const config = loadConfig(dir);
  assert.equal(config, null);
});

test("loadConfig loads repos config", () => {
  const dir = makeTempDir();
  writeConfig(dir, { repos: ["owner/repo1", "owner/repo2"] });
  
  const config = loadConfig(dir);
  assert.deepEqual(config, { repos: ["owner/repo1", "owner/repo2"] });
  
  cleanup(dir);
});

test("loadConfig only loads repos (commentTemplates moved to .copse/)", () => {
  const dir = makeTempDir();
  writeConfig(dir, { repos: ["owner/repo"] });
  
  const config = loadConfig(dir);
  assert.deepEqual(config, { repos: ["owner/repo"] });
  
  cleanup(dir);
});

test("loadConfig returns null for invalid repos", () => {
  const dir = makeTempDir();
  writeConfig(dir, { repos: ["valid", 123, null] });
  
  const config = loadConfig(dir);
  assert.equal(config, null);
  
  cleanup(dir);
});

test("getConfiguredRepos returns repos array", () => {
  const dir = makeTempDir();
  writeConfig(dir, { repos: ["owner/repo1", "owner/repo2"] });
  
  const repos = getConfiguredRepos(dir);
  assert.deepEqual(repos, ["owner/repo1", "owner/repo2"]);
  
  cleanup(dir);
});

test("getConfiguredRepos returns null when no config file", () => {
  const dir = makeTempDir();
  
  const repos = getConfiguredRepos(dir);
  assert.equal(repos, null);
  
  cleanup(dir);
});

test("getCommentTemplates returns templates from MD files", () => {
  cleanupTemplates();
  writeTemplate("01-research.md", "Research", "please research this");
  writeTemplate("02-fix.md", "Fix", "please fix this");
  
  const result = getCommentTemplates();
  assert.deepEqual(result, [
    { label: "Research", message: "please research this" },
    { label: "Fix", message: "please fix this" },
  ]);
  
  cleanupTemplates();
});

test("getCommentTemplates returns null when no templates dir", () => {
  cleanupTemplates();
  
  const result = getCommentTemplates();
  assert.equal(result, null);
});

test("getCommentTemplates sorts templates alphabetically", () => {
  cleanupTemplates();
  writeTemplate("z-zebra.md", "Zebra", "last");
  writeTemplate("a-apple.md", "Apple", "first");
  writeTemplate("m-middle.md", "Middle", "middle");
  
  const result = getCommentTemplates();
  assert.deepEqual(result, [
    { label: "Apple", message: "first" },
    { label: "Middle", message: "middle" },
    { label: "Zebra", message: "last" },
  ]);
  
  cleanupTemplates();
});

test("getCommentTemplates skips templates without frontmatter label", () => {
  cleanupTemplates();
  writeTemplate("01-valid.md", "Valid", "valid message");
  writeFileSync(join(TEMPLATES_DIR, "02-invalid.md"), "no frontmatter");
  
  const result = getCommentTemplates();
  assert.deepEqual(result, [
    { label: "Valid", message: "valid message" },
  ]);
  
  cleanupTemplates();
});

test("getCommentTemplates handles multiline messages", () => {
  cleanupTemplates();
  writeTemplate("01-multiline.md", "Multiline", "line 1\nline 2\nline 3");
  
  const result = getCommentTemplates();
  assert.deepEqual(result, [
    { label: "Multiline", message: "line 1\nline 2\nline 3" },
  ]);
  
  cleanupTemplates();
});
