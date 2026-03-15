/**
 * Checks system health and configuration for copse.
 *
 * Usage: copse doctor
 *
 * Verifies:
 *   - Node.js version (>= 18)
 *   - GitHub CLI (gh) is installed
 *   - GitHub CLI is authenticated
 *   - .copserc config file exists and is valid
 *   - Configured repos are accessible
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { initializeRuntime } from "../lib/runtime-init.js";

initializeRuntime();

const PASS = "\x1b[32m\u2714\x1b[0m"; // green checkmark
const FAIL = "\x1b[31m\u2718\x1b[0m"; // red X

interface CheckResult {
  label: string;
  passed: boolean;
  detail?: string;
}

function checkNodeVersion(): CheckResult {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 18) {
    return { label: "Node.js version", passed: true, detail: `v${process.versions.node}` };
  }
  return {
    label: "Node.js version",
    passed: false,
    detail: `v${process.versions.node} (requires >= 18)`,
  };
}

function checkGhInstalled(): CheckResult {
  try {
    const out = execFileSync("gh", ["--version"], { encoding: "utf-8", timeout: 10_000 });
    const version = out.split("\n")[0]?.trim() || "installed";
    return { label: "GitHub CLI (gh)", passed: true, detail: version };
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") {
      return {
        label: "GitHub CLI (gh)",
        passed: false,
        detail: "Not found in PATH. Install from https://cli.github.com/",
      };
    }
    return { label: "GitHub CLI (gh)", passed: false, detail: "Failed to run gh --version" };
  }
}

function checkGhAuth(): CheckResult {
  try {
    execFileSync("gh", ["auth", "status"], { encoding: "utf-8", timeout: 10_000, stdio: "pipe" });
    return { label: "GitHub CLI auth", passed: true, detail: "Authenticated" };
  } catch (e: unknown) {
    const stderr = ((e as { stderr?: string }).stderr || "").toString();
    if (stderr.includes("not logged") || stderr.includes("no token")) {
      return { label: "GitHub CLI auth", passed: false, detail: "Not authenticated. Run: gh auth login" };
    }
    if ((e as { code?: string }).code === "ENOENT") {
      return { label: "GitHub CLI auth", passed: false, detail: "gh not installed (skipped)" };
    }
    return { label: "GitHub CLI auth", passed: false, detail: "Auth check failed. Run: gh auth login" };
  }
}

interface CopseConfig {
  repos?: string[];
  [key: string]: unknown;
}

function findConfigFile(): { path: string; config: CopseConfig } | { path: null; error: string } {
  const homePath = join(homedir(), ".copserc");

  if (existsSync(homePath)) {
    try {
      const raw = readFileSync(homePath, "utf-8");
      const config = JSON.parse(raw) as CopseConfig;
      return { path: homePath, config };
    } catch {
      return { path: null, error: `${homePath} exists but is not valid JSON` };
    }
  }

  let dir = process.cwd();
  const root = "/";
  while (dir !== root) {
    const candidate = join(dir, ".copserc");
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const config = JSON.parse(raw) as CopseConfig;
        return { path: candidate, config };
      } catch {
        return { path: null, error: `${candidate} exists but is not valid JSON` };
      }
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return { path: null, error: "No .copserc found. Run: copse init" };
}

function checkConfig(): CheckResult & { config?: CopseConfig } {
  const result = findConfigFile();
  if ("error" in result) {
    return { label: "Config file (.copserc)", passed: false, detail: result.error };
  }
  return {
    label: "Config file (.copserc)",
    passed: true,
    detail: result.path!,
    config: result.config,
  };
}

function checkRepoAccess(repo: string): CheckResult {
  try {
    execFileSync("gh", ["api", `repos/${repo}`, "-q", ".full_name"], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: "pipe",
    });
    return { label: `  Repo ${repo}`, passed: true, detail: "accessible" };
  } catch {
    return { label: `  Repo ${repo}`, passed: false, detail: "not accessible or does not exist" };
  }
}

function printResult(result: CheckResult): void {
  const icon = result.passed ? PASS : FAIL;
  const detail = result.detail ? ` — ${result.detail}` : "";
  console.log(`  ${icon} ${result.label}${detail}`);
}

function main(): void {
  console.log("\ncopse doctor\n");

  const results: CheckResult[] = [];
  let hasFailure = false;

  // 1. Node.js version
  const nodeCheck = checkNodeVersion();
  results.push(nodeCheck);

  // 2. gh CLI installed
  const ghCheck = checkGhInstalled();
  results.push(ghCheck);

  // 3. gh authenticated (only if gh is installed)
  if (ghCheck.passed) {
    const authCheck = checkGhAuth();
    results.push(authCheck);
  }

  // 4. Config file
  const configCheck = checkConfig();
  results.push(configCheck);

  // Print core results
  for (const r of results) {
    printResult(r);
    if (!r.passed) hasFailure = true;
  }

  // 5. Check configured repos (only if config and gh auth are good)
  const ghAuthPassed = results.every((r) => r.label !== "GitHub CLI auth" || r.passed);
  if (configCheck.passed && configCheck.config?.repos && ghAuthPassed) {
    const repos = configCheck.config.repos;
    if (repos.length > 0) {
      console.log(`\n  Configured repositories:`);
      for (const repo of repos) {
        const repoResult = checkRepoAccess(repo);
        printResult(repoResult);
        if (!repoResult.passed) hasFailure = true;
      }
    }
  }

  console.log();

  if (hasFailure) {
    console.log("Some checks failed. Please address the issues above.\n");
    process.exit(1);
  } else {
    console.log("All checks passed.\n");
  }
}

main();
