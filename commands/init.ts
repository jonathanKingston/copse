/**
 * Scaffolds a .copserc configuration file interactively.
 *
 * Usage: copse init [options]
 *
 * Walks the user through creating a ~/.copserc file with:
 *   - Repository configuration
 *   - Template files (PR template, issue template in current repo)
 *
 * Options:
 *   --skip-templates  Skip template creation prompts
 *   --force          Overwrite existing .copserc file
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { homedir } from "os";
import { REPO_PATTERN } from "../lib/gh.js";
import { getOriginRepo } from "../lib/utils.js";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

const CONFIG_FILENAME = ".copserc";
const GITHUB_DIR = ".github";

function getConfigPath(): string {
  return join(homedir(), CONFIG_FILENAME);
}

const DEFAULT_PR_TEMPLATE = `## Description

<!-- Describe your changes in detail -->

## Motivation and Context

<!-- Why is this change required? What problem does it solve? -->
<!-- If it fixes an open issue, please link to the issue here. -->

## How Has This Been Tested?

<!-- Please describe how you tested your changes. -->
<!-- Include details of your testing environment, and the tests you ran. -->

## Types of changes

<!-- What types of changes does your code introduce? Put an \`x\` in all the boxes that apply: -->

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)

## Checklist:

<!-- Go over all the following points, and put an \`x\` in all the boxes that apply. -->

- [ ] My code follows the code style of this project.
- [ ] My change requires a change to the documentation.
- [ ] I have updated the documentation accordingly.
- [ ] I have added tests to cover my changes.
- [ ] All new and existing tests passed.
`;

const DEFAULT_ISSUE_TEMPLATE = `## Description

<!-- A clear and concise description of what the issue is. -->

## Expected Behavior

<!-- What should happen? -->

## Current Behavior

<!-- What actually happens? -->

## Steps to Reproduce

1. 
2. 
3. 

## Context

<!-- How has this issue affected you? What are you trying to accomplish? -->

## Environment

- OS: 
- Version: 
`;

interface ScaffoldConfig {
  repos: string[];
}

function validateRepoFormat(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

async function promptYesNo(rl: readline.Interface, question: string, defaultYes: boolean = true): Promise<boolean> {
  const suffix = defaultYes ? " (Y/n)" : " (y/N)";
  const answer = await rl.question(`${ANSI.bold}${question}${suffix}:${ANSI.reset} `);
  const trimmed = answer.trim().toLowerCase();
  
  if (!trimmed) return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

async function promptRepos(rl: readline.Interface): Promise<string[]> {
  const repos: string[] = [];
  
  console.log(`\n${ANSI.cyan}Repository Configuration${ANSI.reset}`);
  console.log(`${ANSI.dim}Enter GitHub repositories in owner/name format (e.g., octocat/hello-world)${ANSI.reset}`);
  console.log(`${ANSI.dim}Leave empty to finish${ANSI.reset}\n`);

  const originRepo = getOriginRepo();
  if (originRepo) {
    const useOrigin = await promptYesNo(rl, `Detected current repo as ${ANSI.cyan}${originRepo}${ANSI.reset}. Add it?`);
    if (useOrigin) {
      repos.push(originRepo);
      console.log(`${ANSI.green}✓${ANSI.reset} Added ${originRepo}\n`);
    }
  }

  let index = repos.length + 1;
  for (;;) {
    const answer = await rl.question(`${ANSI.bold}Repository ${index}:${ANSI.reset} `);
    const trimmed = answer.trim();
    
    if (!trimmed) {
      if (repos.length === 0) {
        console.log(`${ANSI.yellow}Warning: No repositories configured. You can add them to ~/.copserc later.${ANSI.reset}`);
      }
      break;
    }
    
    if (!validateRepoFormat(trimmed)) {
      console.log(`${ANSI.red}Invalid format. Use owner/name (e.g., octocat/hello-world)${ANSI.reset}`);
      continue;
    }
    
    if (repos.includes(trimmed)) {
      console.log(`${ANSI.yellow}Repository already added${ANSI.reset}`);
      continue;
    }
    
    repos.push(trimmed);
    console.log(`${ANSI.green}✓${ANSI.reset} Added ${trimmed}`);
    index++;
  }
  
  return repos;
}

async function promptTemplates(rl: readline.Interface): Promise<{ createPR: boolean; createIssue: boolean }> {
  console.log(`\n${ANSI.cyan}Template Configuration${ANSI.reset}`);
  console.log(`${ANSI.dim}Templates help standardize PRs and issues across your repositories${ANSI.reset}\n`);
  
  const createPR = await promptYesNo(
    rl,
    `Create a PR template at ${ANSI.cyan}${GITHUB_DIR}/PULL_REQUEST_TEMPLATE.md${ANSI.reset}?`
  );
  
  const createIssue = await promptYesNo(
    rl,
    `Create an issue template at ${ANSI.cyan}${GITHUB_DIR}/issue_template.md${ANSI.reset}?`
  );
  
  return { createPR, createIssue };
}

function ensureDirectoryExists(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function createPRTemplate(): void {
  const path = resolve(GITHUB_DIR, "PULL_REQUEST_TEMPLATE.md");
  
  if (existsSync(path)) {
    console.log(`${ANSI.yellow}PR template already exists at ${path}, skipping${ANSI.reset}`);
    return;
  }
  
  ensureDirectoryExists(path);
  writeFileSync(path, DEFAULT_PR_TEMPLATE, "utf-8");
  console.log(`${ANSI.green}✓${ANSI.reset} Created PR template at ${path}`);
}

function createIssueTemplate(): void {
  const path = resolve(GITHUB_DIR, "issue_template.md");
  
  if (existsSync(path)) {
    console.log(`${ANSI.yellow}Issue template already exists at ${path}, skipping${ANSI.reset}`);
    return;
  }
  
  ensureDirectoryExists(path);
  writeFileSync(path, DEFAULT_ISSUE_TEMPLATE, "utf-8");
  console.log(`${ANSI.green}✓${ANSI.reset} Created issue template at ${path}`);
}

function saveConfig(config: ScaffoldConfig, force: boolean): void {
  const configPath = getConfigPath();
  
  if (existsSync(configPath) && !force) {
    console.log(`${ANSI.red}Error: ${configPath} already exists. Use --force to overwrite${ANSI.reset}`);
    process.exit(1);
  }
  
  const json = JSON.stringify(config, null, 2);
  writeFileSync(configPath, json + "\n", "utf-8");
  console.log(`${ANSI.green}✓${ANSI.reset} Created ${configPath}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipTemplates = args.includes("--skip-templates");
  const force = args.includes("--force");
  const isInteractive = stdin.isTTY;

  const help = `Usage: copse init [options]

  Scaffolds a ~/.copserc configuration file and optional templates interactively.

  The ~/.copserc file configures which GitHub repositories copse commands should
  operate on. Templates are created in the current repo's .github directory.

Options:
  --skip-templates  Skip template creation prompts
  --force           Overwrite existing ~/.copserc file

Examples:
  copse init                   # Interactive setup with all prompts
  copse init --skip-templates  # Only configure repos, skip templates
  copse init --force           # Overwrite existing ~/.copserc
`;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    process.exit(0);
  }

  if (!isInteractive) {
    console.error(`${ANSI.red}Error: init command requires an interactive terminal${ANSI.reset}`);
    console.error(`${ANSI.dim}You can manually create ~/.copserc with: { "repos": ["owner/name"] }${ANSI.reset}`);
    process.exit(1);
  }

  const configPath = getConfigPath();
  if (existsSync(configPath) && !force) {
    console.log(`${ANSI.yellow}${configPath} already exists.${ANSI.reset}`);
    console.log(`${ANSI.dim}Use --force to overwrite, or edit ${configPath} manually${ANSI.reset}`);
    process.exit(1);
  }

  console.log(`${ANSI.bold}${ANSI.cyan}Copse Configuration Scaffolder${ANSI.reset}\n`);
  console.log(`${ANSI.dim}This will help you set up ~/.copserc for managing agent PRs${ANSI.reset}`);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const repos = await promptRepos(rl);
    
    let shouldCreatePRTemplate = false;
    let shouldCreateIssueTemplate = false;
    
    if (!skipTemplates) {
      const templates = await promptTemplates(rl);
      shouldCreatePRTemplate = templates.createPR;
      shouldCreateIssueTemplate = templates.createIssue;
    }

    console.log(`\n${ANSI.cyan}Creating configuration...${ANSI.reset}\n`);

    const config: ScaffoldConfig = { repos };
    saveConfig(config, force);

    if (shouldCreatePRTemplate) {
      createPRTemplate();
    }

    if (shouldCreateIssueTemplate) {
      createIssueTemplate();
    }

    console.log(`\n${ANSI.bold}${ANSI.green}Setup complete!${ANSI.reset}\n`);
    
    if (repos.length > 0) {
      console.log(`${ANSI.dim}You can now run commands like:${ANSI.reset}`);
      console.log(`  ${ANSI.cyan}copse status${ANSI.reset} - View all agent PRs across configured repos`);
      console.log(`  ${ANSI.cyan}copse pr-status${ANSI.reset} - Check PR status and CI failures`);
    } else {
      console.log(`${ANSI.dim}Edit ~/.copserc to add repositories:${ANSI.reset}`);
      console.log(`  ${ANSI.cyan}{ "repos": ["owner/name", ...] }${ANSI.reset}`);
    }
    console.log();
  } finally {
    rl.close();
  }
}

main().catch((e: unknown) => {
  console.error(`${ANSI.red}error${ANSI.reset} ${(e as Error).message}`);
  process.exit(1);
});
