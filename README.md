# copse

Tools for managing agent-created PRs. Available at [copse.dev](https://copse.dev).

Seven commands for managing agent-created PRs:

- **approval** – Triggers **merge when ready** on matching PRs (enables auto-merge / adds to merge queue)
- **create-prs** – Finds recent agent branches and creates PRs from them
- **pr-comments** – Lists PR review comments on agent PRs; interactive reply for Cursor/Claude
- **pr-status** – Outlines open agent PRs with test failures and rerun info (also available as `npm test`)
- **rerun-failed** – Reruns failed workflow runs on recent agent branches
- **create-issue** – Creates an issue and comments to instruct the specified agent (cursor or claude) to build it
- **update-main** – Merges main (or specified base) into open PR branches to keep them up to date

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- Node.js 18+

## Installation

```bash
npm install -g @copse/cli
```

## Usage

Run `copse` to see available commands:

```bash
copse
```

Run `copse <command>` to see arguments for a specific command:

```bash
copse approval
copse create-prs
```

### Tab Completion

Tab completion works with both Bash and Zsh. After installing, add this to your shell config:

**Zsh** (add to `~/.zshrc`):

```bash
eval "$(copse completion zsh)"
```

**Bash** (add to `~/.bashrc` or `~/.bash_profile`):

```bash
eval "$(copse completion bash)"
```

Or use `eval "$(copse completion)"` to auto-detect your shell from `$SHELL`.

Apply the change by opening a new terminal or sourcing your config:

```bash
# Open a new terminal (recommended), or:
source ~/.zshrc   # for zsh
source ~/.bashrc  # for bash
```

#### Completion behavior

| Type this | Tab completes to |
|-----------|------------------|
| `copse pr-` | `pr-comments`, `pr-status` |
| `copse ` (with space) | subcommands: `approval`, `create-prs`, `pr-status`, etc. |
| After a subcommand | `--dry-run`, `--all`, `--mine`, `--help` |

## Commands

### copse approval

Triggers **merge when ready** on matching PRs (enables auto-merge / adds to merge queue).

```
copse approval <repo> [agent] [query] [--dry-run] [--all]
```

| Argument | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/name` format |
| `agent` | `cursor` or `claude` to filter by agent |
| `query` | Optional text to match in PR title or body |
| `--dry-run` | Show matching PRs without enabling merge when ready |
| `--mine` | Only your PRs (default) |
| `--all` | Include PRs from all authors |

#### How PRs are matched

A PR matches when it:

1. **Repo** – Is an open PR in the given repository
2. **Author** – By default, only your PRs; use `--all` to include others
3. **Agent** – Either:
   - Branch name contains `cursor` or `claude` (case insensitive), or
   - Has label `cursor`, `cursor-pr`, `claude`, or `claude-pr`
4. **Query** – If provided, title or body contains the query (case insensitive)

#### Examples

```bash
# Enable merge when ready on all cursor PRs in acme/cool-project
copse approval acme/cool-project cursor

# Mark all claude PRs with "fix login" in title or body
copse approval acme/cool-project claude "fix login"

# Preview without making changes
copse approval acme/cool-project cursor --dry-run

# Include PRs from all authors
copse approval acme/cool-project cursor --all
```

#### Merge when ready

Uses `gh pr merge --auto` to trigger the merge-queue/auto-merge action on matching PRs. The repo must have auto-merge and/or merge queue enabled in branch protection (Settings → Branches).

### copse create-prs

Finds agent branches (`cursor/*`, `claude/*`) recently created or updated and creates PRs from them. PR title comes from the latest commit subject; PR body combines an optional template with the commit body (including co-authorship lines).

```
copse create-prs <repo> <agent> [options]
```

| Argument | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/name` format |
| `agent` | `cursor` or `claude` to filter branches |
| `--base BRANCH` | Base branch (default: `main`). Use `pr-releases` for `pr-releases/<head-branch>` |
| `--template PATH` | Path to PR template (default: `.github/PULL_REQUEST_TEMPLATE.md`; falls back to [duckduckgo/content-scope-scripts](https://github.com/duckduckgo/content-scope-scripts/blob/main/.github/pull_request_template.md) template if not found) |
| `--no-template` | Skip template, use only commit body |
| `--hours N` | Only branches with commits in last N hours (default: 6) |
| `--mine` | Only your branches (default) |
| `--all` | Include branches from all authors |
| `--dry-run` | Show branches and PRs that would be created |

#### Examples

```bash
# Create PRs from cursor branches (base: main, last 6 hours)
copse create-prs acme/cool-project cursor

# Target pr-releases/<branch> instead
copse create-prs acme/cool-project claude --base pr-releases

# Custom template and time window
copse create-prs acme/cool-project cursor --template .github/PULL_REQUEST_TEMPLATE.md --hours 12

# Preview branches from last 48 hours
copse create-prs acme/cool-project cursor --hours 48 --dry-run

# Include branches from all authors
copse create-prs acme/cool-project cursor --all
```

### copse pr-status

Lists open agent PRs and outlines their CI/test status: failed workflow runs and rerun counts.

```
copse pr-status [repo] [agent] [options]
```

| Argument | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/name` format. Omit when run inside a git repo to use origin remote. |
| `agent` | Optional: `cursor` or `claude` to filter PRs. Omit to match both. |
| `--mine` | Only your PRs (default) |
| `--all` | Include PRs from all authors |

#### Examples

```bash
# List all your open agent PRs with test status (uses origin when run inside a git repo)
copse pr-status
copse pr-status acme/cool-project

# Filter by agent
copse pr-status acme/cool-project cursor
copse pr-status acme/cool-project claude --all

# Same as pr-status (npm test runs this)
npm test
```

### copse pr-comments

Lists PR review comments on agent PRs so you can view them in the terminal. In interactive mode, select a comment and reply—e.g. "please fix this"—so Cursor or Claude can see and act on your feedback when viewing the PR.

```
copse pr-comments [repo] [pr-number|agent] [options]
```

| Argument | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/name` format. Omit when run inside a git repo to use origin remote. |
| `pr-number` | Specific PR to list comments for. |
| `agent` | Filter PRs by `cursor` or `claude`. Omit to match both. |
| `--no-interactive` | Only list comments; do not enter the reply loop. |
| `--mine` | Only your PRs (default) |
| `--all` | Include PRs from all authors |

#### Examples

```bash
# List comments on agent PRs, then select and reply (interactive)
copse pr-comments
copse pr-comments acme/cool-project cursor

# Comments on a specific PR
copse pr-comments acme/cool-project 42

# List only, no interactive reply
copse pr-comments acme/cool-project claude --no-interactive
```

### copse rerun-failed

Finds recent agent branches (`cursor/*`, `claude/*`) and reruns any failed GitHub Actions workflow runs on them.

```
copse rerun-failed [repo] [agent] [options]
```

Omit `repo` when run inside a git repo to use the origin remote. Omit `agent` to include both cursor and claude branches.

| Argument | Description |
|----------|--------------|
| `repo` | GitHub repo in `owner/name` format (default: origin when in a git repo) |
| `agent` | Optional: `cursor` or `claude` to filter branches. Omit to match both. |
| `--hours N` | Only branches with commits in last N hours (default: 24) |
| `--mine` | Only your branches (default) |
| `--all` | Include branches from all authors |
| `--dry-run` | Show branches and runs that would be rerun without triggering |

#### Examples

```bash
# Uses origin repo, both agents
copse rerun-failed

# Rerun failed tests on cursor branches from last 24 hours
copse rerun-failed acme/cool-project cursor

# Check claude branches from last 48 hours
copse rerun-failed acme/cool-project claude --hours 48 --dry-run
```

### copse create-issue

Creates a GitHub issue and adds a comment instructing the specified agent (cursor or claude) to go and build it.

```
copse create-issue [repo] [title] [body] [agent] [options]
```

| Argument | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/name` format. Omit when run inside a git repo to use origin remote. |
| `title` | Issue title (omit to be prompted) |
| `body` | Optional issue body (omit to open editor with template for interactive fill-in) |
| `agent` | `cursor` or `claude` (default: cursor) – the agent to instruct |
| `--body-file PATH` | Read issue body from file |
| `--template PATH` | Path to issue template (default: look in several locations) |
| `--no-template` | Skip template, use only body |
| `--no-comment` | Do not add the agent instruction comment |
| `--dry-run` | Show what would be created without creating |

On success, prints the issue URL to stdout (e.g. for piping: `copse create-issue ... | xargs open`).

#### Issue template lookup

By default, looks for a template in the following locations (relative to current directory, first found wins):

- `.github/issue_template.md`
- `.github/ISSUE_TEMPLATE/issue_template.md`
- `issue_template.md` (root)
- `docs/issue_template.md`
- First `.md` file in `.github/ISSUE_TEMPLATE/` (if no `issue_template.md`)

YAML frontmatter (e.g. from GitHub issue template builder) is stripped before use. If a template is found and you provide a body, they are merged with `---` as separator.

When no body is provided in an interactive terminal, the template (or an empty buffer) is opened in your `$EDITOR` so you can fill it in. When not interactive (e.g. in a pipeline), you must use `--body` or `--body-file`.

#### Examples

```bash
# Create issue (default: cursor)
copse create-issue acme/cool-project "Add dark mode"

# Specify agent
copse create-issue acme/cool-project "Add dark mode" cursor
copse create-issue acme/cool-project "Fix login bug" "User cannot log in" claude

# Body from file
copse create-issue acme/cool-project "Implement feature X" --body-file spec.md

# Use specific template
copse create-issue acme/cool-project "Bug in login" --template .github/ISSUE_TEMPLATE/bug_report.md

# Skip template, body only
copse create-issue acme/cool-project "Add tests" --no-template --dry-run
```

### copse update-main

Merges the base branch (default: `main`) into open PR branches matching the repo and agent filter. Keeps PRs up to date with the latest main.

```
copse update-main <repo> [agent] [options]
```

| Argument | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/name` format |
| `agent` | Optional: `cursor` or `claude` to filter PRs. Omit to match both. |
| `--base BRANCH` | Branch to merge into PRs (default: `main`) |
| `--mine` | Only your PRs (default) |
| `--all` | Include PRs from all authors |
| `--dry-run` | Show PRs that would be updated without merging |

#### Examples

```bash
# Update all agent PRs with main
copse update-main acme/cool-project

# Update only cursor PRs
copse update-main acme/cool-project cursor

# Preview without merging
copse update-main acme/cool-project cursor --dry-run

# Update all authors' PRs
copse update-main acme/cool-project cursor --all
```
