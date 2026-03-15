import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = join(__dirname, "..", "copse.js");

function run(
  args: string[],
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      { encoding: "utf-8", timeout: 10_000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error ? (error as { status?: number }).status ?? 1 : 0;
        resolve({ stdout: stdout || "", stderr: stderr || "", code });
      }
    );
  });
}

// -- Help output --

test("no arguments prints help with command list", async () => {
  const { stdout, code } = await run([]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("copse - Tools for managing agent-created PRs"));
  assert.ok(stdout.includes("Commands:"));
  assert.ok(stdout.includes("create-prs"));
  assert.ok(stdout.includes("pr-status"));
  assert.ok(stdout.includes("approval"));
  assert.ok(stdout.includes("completion"));
});

test("--help flag prints help", async () => {
  const { stdout, code } = await run(["--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("copse - Tools for managing agent-created PRs"));
  assert.ok(stdout.includes("Commands:"));
});

test("-h flag prints help", async () => {
  const { stdout, code } = await run(["-h"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("copse - Tools for managing agent-created PRs"));
});

// -- Subcommand help --

test("subcommand --help shows usage for create-prs", async () => {
  const { stdout, code } = await run(["create-prs", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage: copse create-prs"));
  assert.ok(stdout.includes("Arguments:"));
  assert.ok(stdout.includes("--dry-run"));
});

test("subcommand --help shows usage for approval", async () => {
  const { stdout, code } = await run(["approval", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage: copse approval"));
  assert.ok(stdout.includes("--dry-run"));
});

test("subcommand --help shows usage for pr-status", async () => {
  const { stdout, code } = await run(["pr-status", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage: copse pr-status"));
});

test("subcommand --help shows usage for init", async () => {
  const { stdout, code } = await run(["init", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage: copse init"));
  assert.ok(stdout.includes("--force"));
  assert.ok(stdout.includes("--skip-templates"));
});

test("subcommand --help shows usage for status", async () => {
  const { stdout, code } = await run(["status", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage: copse status"));
  assert.ok(stdout.includes("--no-watch"));
});

test("subcommand -h also works", async () => {
  const { stdout, code } = await run(["create-prs", "-h"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage: copse create-prs"));
});

// -- Unknown command --

test("unknown command exits with error", async () => {
  const { stderr, code } = await run(["nonexistent-command"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.includes("Unknown command: nonexistent-command"));
});

test("unknown command suggests running copse for help", async () => {
  const { stderr } = await run(["bogus"]);
  assert.ok(stderr.includes("Run 'copse' to see available commands."));
});

// -- Completion generation --

test("completion bash outputs bash completion script", async () => {
  const { stdout, code } = await run(["completion", "bash"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("_copse_completion"));
  assert.ok(stdout.includes("complete -F _copse_completion copse"));
  assert.ok(stdout.includes("create-prs"));
});

test("completion zsh outputs zsh completion script", async () => {
  const { stdout, code } = await run(["completion", "zsh"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("#compdef copse"));
  assert.ok(stdout.includes("_copse"));
  assert.ok(stdout.includes("compdef _copse copse"));
});

test("completion with no arg defaults based on SHELL env", async () => {
  const { stdout, code } = await run(["completion"], { SHELL: "/bin/zsh" });
  assert.equal(code, 0);
  assert.ok(stdout.includes("#compdef copse"));
});

test("completion with no arg defaults to bash for non-zsh shell", async () => {
  const { stdout, code } = await run(["completion"], { SHELL: "/bin/bash" });
  assert.equal(code, 0);
  assert.ok(stdout.includes("_copse_completion"));
});

test("completion --help shows usage", async () => {
  const { stdout, code } = await run(["completion", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage: copse completion"));
});

test("completion with invalid shell exits with error", async () => {
  const { stderr, code } = await run(["completion", "fish"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.includes("Usage: copse completion [bash|zsh]"));
});

// -- Commands fail gracefully when gh is unavailable --

test("commands requiring gh fail gracefully with bad PATH", async () => {
  // Run with an empty PATH so `gh` cannot be found.
  // The "init" command is excluded because it skips the gh check.
  const { stderr, code } = await run(["pr-status"], { PATH: "" });
  assert.notEqual(code, 0);
  assert.ok(
    stderr.includes("GitHub CLI (gh) is not installed") ||
      stderr.includes("gh") ||
      stderr.includes("not found"),
    `Expected gh-related error message, got: ${stderr}`
  );
});

test("init command does not require gh", async () => {
  // init skips ensureGh(), so even with no PATH it should not fail
  // with a gh-not-found error. It will either show help or run normally.
  const { stderr } = await run(["init", "--help"], { PATH: "" });
  assert.ok(
    !stderr.includes("GitHub CLI (gh) is not installed"),
    "init should not require gh"
  );
});

// -- Help output includes all expected commands --

test("help output lists all registered commands", async () => {
  const { stdout } = await run([]);
  const expectedCommands = [
    "init",
    "approval",
    "create-prs",
    "pr-status",
    "pr-comments",
    "status",
    "rerun-failed",
    "create-issue",
    "update-main",
    "web",
    "artifacts",
    "completion",
  ];
  for (const cmd of expectedCommands) {
    assert.ok(
      stdout.includes(cmd),
      `Help output should list the "${cmd}" command`
    );
  }
});
