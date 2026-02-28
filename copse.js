#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const COMMANDS = {
  approval: {
    file: "approval.js",
    description: "Triggers merge when ready on matching PRs",
    usage: "copse approval <repo> [agent] [query] [--dry-run] [--all]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format" },
      { name: "agent", description: 'Optional: "cursor" or "claude"' },
      { name: "query", description: "Optional text to match in PR title or body" },
      { name: "--dry-run", description: "Show matching PRs without enabling merge when ready" },
      { name: "--all", description: "Include PRs from all authors (default: only yours)" },
    ],
  },
  "create-prs": {
    file: "create-prs.js",
    description: "Finds recent agent branches and creates PRs from them",
    usage: "copse create-prs <repo> <agent> [options]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format" },
      { name: "agent", description: '"cursor" or "claude" to filter branches' },
      { name: "--base BRANCH", description: "Base branch (default: main)" },
      { name: "--template PATH", description: "Path to PR template" },
      { name: "--hours N", description: "Only branches with commits in last N hours (default: 6)" },
      { name: "--dry-run", description: "Show branches without creating PRs" },
      { name: "--all", description: "Include branches from all authors" },
    ],
  },
  "pr-status": {
    file: "pr-status.js",
    description: "Lists open agent PRs with test failures and rerun info",
    usage: "copse pr-status <repo> [agent] [options]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format" },
      { name: "agent", description: 'Optional: "cursor" or "claude"' },
      { name: "--all", description: "Include PRs from all authors" },
    ],
  },
  "rerun-failed": {
    file: "rerun-failed.js",
    description: "Reruns failed workflow runs on recent agent branches",
    usage: "copse rerun-failed <repo> <agent> [options]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format" },
      { name: "agent", description: '"cursor" or "claude" to filter branches' },
      { name: "--hours N", description: "Only branches with commits in last N hours (default: 24)" },
      { name: "--dry-run", description: "Show branches without triggering reruns" },
      { name: "--all", description: "Include branches from all authors" },
    ],
  },
  "update-main": {
    file: "update-main.js",
    description: "Merges main into open PR branches to keep them up to date",
    usage: "copse update-main <repo> [agent] [options]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format" },
      { name: "agent", description: 'Optional: "cursor" or "claude"' },
      { name: "--base BRANCH", description: "Branch to merge into PRs (default: main)" },
      { name: "--dry-run", description: "Show PRs without merging" },
      { name: "--all", description: "Include PRs from all authors" },
    ],
  },
};

function showHelp() {
  console.log(`copse - Tools for managing agent-created PRs

Usage: copse <command> [arguments]

Commands:`);

  const maxLen = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(maxLen)}  ${cmd.description}`);
  }

  console.log(`
Run 'copse <command>' to see arguments for that command.
Run 'copse <command> --help' for detailed help.

Tab completion: Run 'copse completion' to get bash completion script.
`);
}

function showCommandHelp(command) {
  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  console.log(`${cmd.description}

Usage: ${cmd.usage}

Arguments:`);

  const maxLen = Math.max(...cmd.args.map((a) => a.name.length));
  for (const arg of cmd.args) {
    console.log(`  ${arg.name.padEnd(maxLen)}  ${arg.description}`);
  }
  console.log();
}

function generateCompletion() {
  const script = `# Bash completion for copse
_copse_completion() {
    local cur prev commands
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    commands="${Object.keys(COMMANDS).join(" ")}"

    if [ $COMP_CWORD -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$commands completion" -- "$cur") )
        return 0
    fi

    case "\${COMP_WORDS[1]}" in
        approval|create-prs|pr-status|rerun-failed|update-main)
            COMPREPLY=( $(compgen -W "--dry-run --all --mine --help" -- "$cur") )
            ;;
    esac
}

complete -F _copse_completion copse

# Usage: Add this to your ~/.bashrc or ~/.bash_profile:
#   eval "$(copse completion)"
`;
  console.log(script);
}

function runCommand(command, args) {
  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'copse' to see available commands.`);
    process.exit(1);
  }

  const commandPath = join(__dirname, "commands", cmd.file);
  const child = spawn("node", [commandPath, ...args], {
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    process.exit(code || 0);
  });
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const command = args[0];

  if (command === "completion") {
    generateCompletion();
    process.exit(0);
  }

  if (command === "--help" || command === "-h") {
    showHelp();
    process.exit(0);
  }

  if (args.length === 1 || args[1] === "--help" || args[1] === "-h") {
    showCommandHelp(command);
    process.exit(0);
  }

  runCommand(command, args.slice(1));
}

main();
