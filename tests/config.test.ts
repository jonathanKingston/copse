import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadConfig, getConfiguredRepos } from "../lib/config.js";
import { setApiProvider, resetApiProvider } from "../lib/api-provider.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "copse-config-test-"));
}

function writeConfig(dir: string, content: string): void {
  writeFileSync(join(dir, ".copserc"), content, "utf-8");
}

// Ensure no API provider interferes with tests
test.beforeEach(() => {
  resetApiProvider();
});

test.afterEach(() => {
  resetApiProvider();
});

// --- Valid JSON parsing ---

test("loadConfig parses a valid config with repos", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: ["owner/repo1", "owner/repo2"] }));
    const config = loadConfig(dir);
    assert.deepEqual(config?.repos, ["owner/repo1", "owner/repo2"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig parses a valid config with all fields", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(
      dir,
      JSON.stringify({
        repos: ["a/b"],
        commentTemplates: "./templates",
        cursorApiKey: "key-123",
      })
    );
    const config = loadConfig(dir);
    assert.deepEqual(config?.repos, ["a/b"]);
    assert.equal(config?.commentTemplates, "./templates");
    assert.equal(config?.cursorApiKey, "key-123");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig accepts an empty object", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, "{}");
    const config = loadConfig(dir);
    assert.ok(config !== null);
    assert.equal(config?.repos, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// --- Malformed JSON handling ---

test("loadConfig returns null for malformed JSON", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, "{ not valid json !!!");
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig returns null for JSON that is a bare string", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, '"just a string"');
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig returns null for JSON that is a number", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, "42");
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig returns null for JSON null", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, "null");
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig treats JSON array as valid (arrays are objects)", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, '["owner/repo"]');
    const config = loadConfig(dir);
    // Arrays pass typeof === "object" check; no repos/commentTemplates/cursorApiKey
    // keys are present, so all validation passes. This is accepted.
    assert.ok(config !== null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// --- Missing config file behavior ---

test("loadConfig returns null when no config file exists", () => {
  const dir = makeTmpDir();
  try {
    // No .copserc written — directory is empty
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig finds config in parent directory", () => {
  const parent = makeTmpDir();
  const child = join(parent, "subdir");
  mkdirSync(child, { recursive: true });
  try {
    writeConfig(parent, JSON.stringify({ repos: ["found/in-parent"] }));
    const config = loadConfig(child);
    assert.deepEqual(config?.repos, ["found/in-parent"]);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

// --- Missing/optional fields ---

test("loadConfig accepts config with only commentTemplates", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ commentTemplates: "./tpl" }));
    const config = loadConfig(dir);
    assert.ok(config !== null);
    assert.equal(config?.commentTemplates, "./tpl");
    assert.equal(config?.repos, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig accepts config with only cursorApiKey", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ cursorApiKey: "sk-abc" }));
    const config = loadConfig(dir);
    assert.ok(config !== null);
    assert.equal(config?.cursorApiKey, "sk-abc");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig ignores extra unknown fields", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: ["a/b"], unknownField: true }));
    const config = loadConfig(dir);
    assert.deepEqual(config?.repos, ["a/b"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// --- Type validation of config values ---

test("loadConfig rejects repos that is not an array of strings", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: [1, 2, 3] }));
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig rejects repos that is a string instead of array", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: "owner/repo" }));
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig rejects commentTemplates that is not a string", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ commentTemplates: 123 }));
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig rejects cursorApiKey that is not a string", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ cursorApiKey: false }));
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig rejects repos array containing mixed types", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: ["valid/repo", 42] }));
    const config = loadConfig(dir);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// --- getConfiguredRepos ---

test("getConfiguredRepos returns repos from config", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: ["org/app"] }));
    const repos = getConfiguredRepos(dir);
    assert.deepEqual(repos, ["org/app"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("getConfiguredRepos returns null when no config exists", () => {
  const dir = makeTmpDir();
  try {
    const repos = getConfiguredRepos(dir);
    assert.equal(repos, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("getConfiguredRepos returns null when repos is empty array", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: [] }));
    const repos = getConfiguredRepos(dir);
    assert.equal(repos, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("getConfiguredRepos returns null when repos field is missing", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ commentTemplates: "./tpl" }));
    const repos = getConfiguredRepos(dir);
    assert.equal(repos, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// --- API provider override ---

test("loadConfig delegates to API provider when one is set", () => {
  const dir = makeTmpDir();
  try {
    writeConfig(dir, JSON.stringify({ repos: ["should/not-see-this"] }));
    setApiProvider({
      loadConfig: () => ({ repos: ["from/provider"] }),
    });
    const config = loadConfig(dir);
    assert.deepEqual(config?.repos, ["from/provider"]);
  } finally {
    resetApiProvider();
    rmSync(dir, { recursive: true });
  }
});

test("getConfiguredRepos delegates to API provider when one is set", () => {
  setApiProvider({
    getConfiguredRepos: () => ["provider/repo"],
  });
  try {
    const repos = getConfiguredRepos("/nonexistent");
    assert.deepEqual(repos, ["provider/repo"]);
  } finally {
    resetApiProvider();
  }
});
