import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadConfig, getCommentTemplates, getConfiguredRepos } from "../lib/config.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `copse-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, config: object): void {
  writeFileSync(join(dir, ".copserc"), JSON.stringify(config, null, 2));
}

function cleanup(dir: string): void {
  try {
    unlinkSync(join(dir, ".copserc"));
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

test("loadConfig loads commentTemplates config", () => {
  const dir = makeTempDir();
  const templates = [
    { label: "Test 1", message: "message 1" },
    { label: "Test 2", message: "message 2" },
  ];
  writeConfig(dir, { commentTemplates: templates });
  
  const config = loadConfig(dir);
  assert.deepEqual(config, { commentTemplates: templates });
  
  cleanup(dir);
});

test("loadConfig loads both repos and commentTemplates", () => {
  const dir = makeTempDir();
  const templates = [{ label: "Test", message: "msg" }];
  writeConfig(dir, {
    repos: ["owner/repo"],
    commentTemplates: templates,
  });
  
  const config = loadConfig(dir);
  assert.deepEqual(config, {
    repos: ["owner/repo"],
    commentTemplates: templates,
  });
  
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

test("getConfiguredRepos returns null when no repos", () => {
  const dir = makeTempDir();
  writeConfig(dir, { commentTemplates: [{ label: "Test", message: "msg" }] });
  
  const repos = getConfiguredRepos(dir);
  assert.equal(repos, null);
  
  cleanup(dir);
});

test("getCommentTemplates returns templates array", () => {
  const dir = makeTempDir();
  const templates = [
    { label: "Research", message: "please research this" },
    { label: "Fix", message: "please fix this" },
  ];
  writeConfig(dir, { commentTemplates: templates });
  
  const result = getCommentTemplates(dir);
  assert.deepEqual(result, templates);
  
  cleanup(dir);
});

test("getCommentTemplates returns null when no templates", () => {
  const dir = makeTempDir();
  writeConfig(dir, { repos: ["owner/repo"] });
  
  const result = getCommentTemplates(dir);
  assert.equal(result, null);
  
  cleanup(dir);
});

test("getCommentTemplates validates template structure", () => {
  const dir = makeTempDir();
  
  writeConfig(dir, {
    commentTemplates: [
      { label: "Valid", message: "valid message" },
      { label: "", message: "invalid - empty label" },
    ],
  });
  
  const result = getCommentTemplates(dir);
  assert.equal(result, null);
  
  cleanup(dir);
});

test("getCommentTemplates rejects invalid template types", () => {
  const dir = makeTempDir();
  
  writeConfig(dir, {
    commentTemplates: [
      { label: "Valid", message: "valid message" },
      { label: 123, message: "invalid - numeric label" },
    ],
  });
  
  const result = getCommentTemplates(dir);
  assert.equal(result, null);
  
  cleanup(dir);
});
