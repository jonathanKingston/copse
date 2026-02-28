# copse

Tools for managing agent-created PRs. Available at [copse.dev](https://copse.dev).

Five commands for managing agent-created PRs:

- **approval** – Triggers **merge when ready** on matching PRs (enables auto-merge / adds to merge queue)
- **create-prs** – Finds recent agent branches and creates PRs from them
- **pr-status** – Outlines open agent PRs with test failures and rerun info (also available as `npm test`)
- **rerun-failed** – Reruns failed workflow runs on recent agent branches
- **update-main** – Merges main (or specified base) into open PR branches to keep them up to date

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- Node.js 18+

## Installation

```bash
npm install -g copse
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

Enable bash tab completion by adding this to your `~/.bashrc` or `~/.bash_profile`:

```bash
eval "$(copse completion)"
```

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
copse pr-status <repo> [agent] [options]
```

| Argument | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/name` format |
| `agent` | Optional: `cursor` or `claude` to filter PRs. Omit to match both. |
| `--mine` | Only your PRs (default) |
| `--all` | Include PRs from all authors |

#### Examples

```bash
# List all your open agent PRs with test status
copse pr-status acme/cool-project

# Filter by agent
copse pr-status acme/cool-project cursor
copse pr-status acme/cool-project claude --all

# Same as pr-status (npm test runs this)
npm test
```

### copse rerun-failed

Finds recent agent branches (`cursor/*`, `claude/*`) and reruns any failed GitHub Actions workflow runs on them.

```
copse rerun-failed <repo> <agent> [options]
```

| Argument | Description |
|----------|--------------|
| `repo` | GitHub repo in `owner/name` format |
| `agent` | `cursor` or `claude` to filter branches |
| `--hours N` | Only branches with commits in last N hours (default: 24) |
| `--mine` | Only your branches (default) |
| `--all` | Include branches from all authors |
| `--dry-run` | Show branches and runs that would be rerun without triggering |

#### Examples

```bash
# Rerun failed tests on cursor branches from last 24 hours
copse rerun-failed acme/cool-project cursor

# Check claude branches from last 48 hours
copse rerun-failed acme/cool-project claude --hours 48 --dry-run
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
