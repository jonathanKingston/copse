#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { CommandDef } from "./lib/types.js";
import { ensureGh, GhNotFoundError, GhNotAuthenticatedError } from "./lib/gh.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// File references use .js extensions — these point to the tsc-compiled output in dist/
const COMMANDS: Record<string, CommandDef> = {
  init: {
    file: "init.js",
    description: "Scaffolds ~/.copserc config and templates interactively",
    usage: "copse init [--skip-templates] [--force]",
    args: [
      { name: "--skip-templates", description: "Skip template creation prompts" },
      { name: "--force", description: "Overwrite existing ~/.copserc file" },
    ],
  },
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
      { name: "--no-template", description: "Skip template, use only commit body" },
      { name: "--hours N", description: "Only branches with commits in last N hours (default: 6)" },
      { name: "--dry-run", description: "Show branches without creating PRs" },
      { name: "--all", description: "Include branches from all authors" },
    ],
  },
  "pr-status": {
    file: "pr-status.js",
    description: "Lists open agent PRs with test failures and rerun info",
    usage: "copse pr-status [repo] [agent] [options]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format (default: origin)" },
      { name: "agent", description: 'Optional: "cursor" or "claude"' },
      { name: "--all", description: "Include PRs from all authors" },
    ],
  },
  "pr-comments": {
    file: "pr-comments.js",
    description: "Lists PR review comments on agent PRs; interactive reply for Cursor/Claude",
    usage: "copse pr-comments [repo] [pr-number|agent] [options]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format (default: origin)" },
      { name: "pr-number|agent", description: "Specific PR number or filter: cursor/claude" },
      { name: "--no-interactive", description: "Only list comments, do not enter reply loop" },
      { name: "--all", description: "Include PRs from all authors" },
    ],
  },
  status: {
    file: "status.js",
    description: "Unified dashboard: agent PRs across all repos (htop-style)",
    usage: "copse status [--no-watch] [--all]",
    args: [
      { name: "--no-watch", description: "One-shot table output (default: live TUI)" },
      { name: "--all", description: "Include PRs from all authors" },
    ],
  },
  "rerun-failed": {
    file: "rerun-failed.js",
    description: "Reruns failed workflow runs on recent agent branches",
    usage: "copse rerun-failed [repo] [agent] [options]",
    args: [
      { name: "repo", description: "GitHub repo (default: origin when in a git repo)" },
      { name: "agent", description: 'Optional: "cursor" or "claude" (default: both)' },
      { name: "--hours N", description: "Only branches with commits in last N hours (default: 24)" },
      { name: "--dry-run", description: "Show branches without triggering reruns" },
      { name: "--all", description: "Include branches from all authors" },
    ],
  },
  "create-issue": {
    file: "create-issue.js",
    description: "Creates an issue and comments to instruct the specified agent to build it",
    usage: "copse create-issue [repo] [title] [body] [agent] [options]",
    args: [
      { name: "repo", description: "GitHub repo in owner/name format (or omit to use origin)" },
      { name: "title", description: "Issue title (omit to be prompted)" },
      { name: "body", description: "Optional issue body (omit to open editor)" },
      { name: "agent", description: '"cursor", "claude", or "copilot" (default: cursor)' },
      { name: "--body-file PATH", description: "Read issue body from file" },
      { name: "--template PATH", description: "Path to issue template" },
      { name: "--no-template", description: "Skip template, use only body" },
      { name: "--no-comment", description: "Do not add the agent instruction comment" },
      { name: "--dry-run", description: "Show what would be created without creating" },
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

function showHelp(): void {
  console.log(`copse - Tools for managing agent-created PRs

Usage: copse <command> [arguments]

Commands:`);

  const maxLen = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(maxLen)}  ${cmd.description}`);
  }
  console.log(`  ${"completion".padEnd(maxLen)}  Output shell completion script (bash/zsh)`);

  console.log(`
Run 'copse <command>' to see arguments for that command.
Run 'copse <command> --help' for detailed help.

Tab completion: eval "\$(copse completion)"   # or "copse completion zsh" for zsh
`);
}

function showCommandHelp(command: string): void {
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

function generateCompletion(shell: "bash" | "zsh"): void {
  const commands = [...Object.keys(COMMANDS), "completion"].join(" ");
  
  const commonOpts: Record<string, string> = { "--dry-run": "Preview without acting", "--all": "Include all authors", "--mine": "Only yours", "--help": "Show help" };
  const initOpts: Record<string, string> = { "--skip-templates": "Skip template creation", "--force": "Overwrite existing config", "--help": "Show help" };
  const statusOpts: Record<string, string> = { "--no-watch": "One-shot output (default: live TUI)", "--all": "Include all authors", "--mine": "Only yours", "--help": "Show help" };
  const prCommentsOpts: Record<string, string> = { "--no-interactive": "List only, no reply loop", "--all": "Include all authors", "--mine": "Only yours", "--help": "Show help" };
  const baseOpts: Record<string, string> = { "--base": "Base branch", ...commonOpts };
  const createPrsOpts: Record<string, string> = { "--base": "Base branch", "--template": "PR template path", "--no-template": "Skip template", "--hours": "Time window in hours", ...commonOpts };
  const rerunFailedOpts: Record<string, string> = { "--hours": "Time window in hours", ...commonOpts };
  const createIssueOpts: Record<string, string> = { "--body-file": "Read body from file", "--template": "Issue template path", "--no-template": "Skip template", "--no-comment": "Skip agent comment", "--dry-run": "Preview without acting", "--help": "Show help" };

  if (shell === "zsh") {
    const subcmds = [
      ...Object.keys(COMMANDS).map((c) => `${c}[${COMMANDS[c].description}]`),
      "completion[Output shell completion script]",
    ]
      .map((s) => `'${s.replace(/'/g, "'\\''")}'`)
      .join(" ");
    
    const formatOptArgs = (opts: Record<string, string>): string => Object.entries(opts)
      .map(([o, d]) => `'${o}[${d.replace(/'/g, "'\\''")}]'`)
      .join(" ");

    const script = `#compdef copse
# Zsh completion for copse

_copse() {
  local state line
  typeset -A opt_args

  _arguments -C \\
    '1: :->subcmd' \\
    '*:: :->args'

  case \$state in
    subcmd)
      _values 'command' ${subcmds}
      ;;
    args)
      case \$line[1] in
        init)
          _arguments ${formatOptArgs(initOpts)}
          ;;
        approval|pr-status)
          _arguments ${formatOptArgs(commonOpts)}
          ;;
        pr-comments)
          _arguments ${formatOptArgs(prCommentsOpts)}
          ;;
        status)
          _arguments ${formatOptArgs(statusOpts)}
          ;;
        update-main)
          _arguments ${formatOptArgs(baseOpts)}
          ;;
        create-prs)
          _arguments ${formatOptArgs(createPrsOpts)}
          ;;
        rerun-failed)
          _arguments ${formatOptArgs(rerunFailedOpts)}
          ;;
        create-issue)
          _arguments ${formatOptArgs(createIssueOpts)}
          ;;
      esac
      ;;
  esac
}

compdef _copse copse

# Usage: Add to your ~/.zshrc:
#   eval "\\$(copse completion zsh)"
`;
    console.log(script);
    return;
  }

  // bash
  const formatBashOpts = (opts: Record<string, string>): string => Object.keys(opts).join(" ");
  
  const script = `# Bash completion for copse
_copse_completion() {
    local cur commands
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    commands="${commands}"

    if [ $COMP_CWORD -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
        return 0
    fi

    case "\${COMP_WORDS[1]}" in
        init)
            COMPREPLY=( $(compgen -W "${formatBashOpts(initOpts)}" -- "$cur") )
            ;;
        approval|pr-status)
            COMPREPLY=( $(compgen -W "${formatBashOpts(commonOpts)}" -- "$cur") )
            ;;
        pr-comments)
            COMPREPLY=( $(compgen -W "${formatBashOpts(prCommentsOpts)}" -- "$cur") )
            ;;
        status)
            COMPREPLY=( $(compgen -W "${formatBashOpts(statusOpts)}" -- "$cur") )
            ;;
        update-main)
            COMPREPLY=( $(compgen -W "${formatBashOpts(baseOpts)}" -- "$cur") )
            ;;
        create-prs)
            COMPREPLY=( $(compgen -W "${formatBashOpts(createPrsOpts)}" -- "$cur") )
            ;;
        rerun-failed)
            COMPREPLY=( $(compgen -W "${formatBashOpts(rerunFailedOpts)}" -- "$cur") )
            ;;
        create-issue)
            COMPREPLY=( $(compgen -W "${formatBashOpts(createIssueOpts)}" -- "$cur") )
            ;;
    esac
}

complete -F _copse_completion copse

# Usage: Add to your ~/.bashrc or ~/.bash_profile:
#   eval "\$(copse completion bash)"
`;
  console.log(script);
}

function runCommand(command: string, args: string[]): void {
  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'copse' to see available commands.`);
    process.exit(1);
  }

  if (command !== "init") {
    try {
      ensureGh();
    } catch (e: unknown) {
      if (e instanceof GhNotFoundError || e instanceof GhNotAuthenticatedError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  }

  const commandPath = join(__dirname, "commands", cmd.file);
  const child = spawn("node", [commandPath, ...args], {
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const command = args[0];

  if (command === "completion") {
    if (args[1] === "--help" || args[1] === "-h") {
      console.log(`Output shell completion script. Detects zsh vs bash from $SHELL when no arg given.

Usage: copse completion [bash|zsh]

Add to your shell config (~/.zshrc or ~/.bashrc):
  eval "$(copse completion)"
`);
      process.exit(0);
    }
    let shell = args[1];
    if (!shell) {
      const envShell = process.env.SHELL || "";
      shell = envShell.endsWith("zsh") ? "zsh" : "bash";
    }
    if (shell !== "bash" && shell !== "zsh") {
      console.error("Usage: copse completion [bash|zsh]");
      process.exit(1);
    }
    generateCompletion(shell);
    process.exit(0);
  }

  if (command === "--help" || command === "-h") {
    showHelp();
    process.exit(0);
  }

  if (args[1] === "--help" || args[1] === "-h") {
    showCommandHelp(command);
    process.exit(0);
  }

  runCommand(command, args.slice(1));
}

main();
