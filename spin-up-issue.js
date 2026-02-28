#!/usr/bin/env node

/**
 * Creates a GitHub issue and comments on it to instruct the specified agent to build it.
 *
 * Usage: spin-up-issue <repo> <agent> <title> [body] [options]
 *
 * Arguments:
 *   repo   - GitHub repo in owner/name format (e.g. acme/cool-project).
 *            Omit when run inside a git repo to use origin remote.
 *   agent  - "cursor" or "claude" (required) – the agent to instruct
 *   title  - Issue title
 *   body   - Optional issue body (omit to open editor with template for interactive fill-in)
 *
 * Options:
 *   --body-file PATH  Read issue body from file
 *   --template PATH   Path to issue template (default: look in .github/issue_template.md, etc.)
 *   --no-template    Skip template, use only body
 *   --dry-run        Show what would be created without creating
 *
 * Template lookup (first found): .github/issue_template.md,
 * .github/ISSUE_TEMPLATE/issue_template.md, issue_template.md, docs/issue_template.md,
 * or first .md in .github/ISSUE_TEMPLATE/. YAML frontmatter is stripped.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/** Issue template paths to try (relative to cwd), in order. Mirrors PR template locations. */
const DEFAULT_ISSUE_TEMPLATE_PATHS = [
  ".github/issue_template.md",
  ".github/ISSUE_TEMPLATE/issue_template.md",
  "issue_template.md",
  "docs/issue_template.md",
];

function getFirstIssueTemplateInFolder() {
  const dir = resolve(".github/ISSUE_TEMPLATE");
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    if (files.length === 0) return null;
    const content = readFileSync(resolve(dir, files[0]), "utf-8").trim();
    return content ? stripFrontmatter(content) : null;
  } catch {
    return null;
  }
}

function stripFrontmatter(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

function resolveIssueTemplate(templatePath, noTemplate) {
  if (noTemplate) return null;
  if (templatePath) {
    try {
      const content = readFileSync(resolve(templatePath), "utf-8").trim();
      return content ? stripFrontmatter(content) : null;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      console.error(`Warning: template file not found: ${templatePath}`);
      return null;
    }
  }
  for (const p of DEFAULT_ISSUE_TEMPLATE_PATHS) {
    const full = resolve(p);
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, "utf-8").trim();
        return content ? stripFrontmatter(content) : null;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        return null;
      }
    }
  }
  return getFirstIssueTemplateInFolder();
}

/** Agent name → @mention handle for GitHub comments. */
const AGENT_MENTIONS = {
  cursor: "@cursor",
  claude: "@claude",
};

function buildIssueBody(templateContent, userBody) {
  if (userBody) {
    return templateContent
      ? `${templateContent}\n\n---\n\n${userBody}`
      : userBody;
  }
  return templateContent || undefined;
}

function validateRepo(repo) {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repo: "${repo}". Use owner/name format (e.g. acme/cool-project)`);
  }
}

function exec(cmd, options = {}) {
  return execSync(cmd, { encoding: "utf-8", ...options });
}

function getOriginRepo() {
  try {
    const url = exec("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const match = url.match(/github\.com[:/]([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function escapeShell(s) {
  return (s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function editBodyInteractively(templateContent) {
  if (!process.stdin.isTTY) {
    throw new Error("No body provided and not running interactively. Use --body or --body-file.");
  }
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  const tmpPath = join(tmpdir(), `spin-up-issue-${Date.now()}.md`);
  try {
    writeFileSync(tmpPath, templateContent || "", "utf-8");
    execSync(editor + " " + JSON.stringify(tmpPath), { stdio: "inherit", shell: true });
    const content = readFileSync(tmpPath, "utf-8").trim();
    return content || ".";
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

function createIssue(repo, title, body, agent, dryRun) {
  if (dryRun) {
    console.error(`Would create issue: "${title}"`);
    if (body) console.error(`  Body: ${body.slice(0, 80)}${body.length > 80 ? "..." : ""}`);
    return null;
  }

  const bodyArg = body ? ["--body-file -"] : [`--body "${escapeShell(".")}"`];
  const args = [
    "gh issue create",
    `--repo ${repo}`,
    `--title "${escapeShell(title)}"`,
    ...bodyArg,
  ].join(" ");

  const out = exec(args, body ? { input: body } : {});
  const match = out.trim().match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function addComment(repo, issueNumber, comment, dryRun) {
  if (dryRun) {
    console.error(`Would add comment: "${comment.slice(0, 60)}${comment.length > 60 ? "..." : ""}"`);
    return;
  }
  exec(`gh issue comment ${issueNumber} --repo ${repo} --body "${escapeShell(comment)}"`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const noComment = args.includes("--no-comment");
  const noTemplate = args.includes("--no-template");
  const bodyFileIdx = args.indexOf("--body-file");
  const bodyFilePath = bodyFileIdx >= 0 ? args[bodyFileIdx + 1] : null;
  const templateIdx = args.indexOf("--template");
  const templatePath = templateIdx >= 0 ? args[templateIdx + 1] : null;
  const filtered = args.filter((a, i) => {
    if (a === "--dry-run") return false;
    if (a === "--no-comment") return false;
    if (a === "--no-template") return false;
    if (a === "--body-file") return false;
    if (a === "--template") return false;
    if (bodyFileIdx >= 0 && i === bodyFileIdx + 1) return false;
    if (templateIdx >= 0 && i === templateIdx + 1) return false;
    return true;
  });

  const help = `Usage: spin-up-issue <repo> <agent> <title> [body] [options]

  repo         GitHub repo in owner/name format (e.g. acme/cool-project).
               Omit when run inside a git repo to use origin remote.
  agent        "cursor" or "claude" (required) – the agent to instruct
  title        Issue title
  body         Optional issue body (omit for empty)

Options:
  --body-file PATH   Read issue body from file
  --template PATH    Path to issue template (default: look in .github/issue_template.md,
                     .github/ISSUE_TEMPLATE/issue_template.md, issue_template.md, docs/issue_template.md)
  --no-template      Skip template, use only body
  --no-comment       Do not add the agent instruction comment
  --dry-run          Show what would be created without creating

Examples:
  spin-up-issue acme/cool-project cursor "Add dark mode"
  spin-up-issue acme/cool-project claude "Fix login bug" "User cannot log in after password reset"
  spin-up-issue acme/cool-project cursor "Implement feature X" --body-file spec.md
  spin-up-issue acme/cool-project cursor "Add tests" --template .github/ISSUE_TEMPLATE/bug_report.md
  spin-up-issue acme/cool-project cursor "Add tests" --no-template --dry-run
  spin-up-issue acme/cool-project cursor "Add feature" --no-comment   # create issue only, no comment
`;

  let repo, agent, title, body;
  if (bodyFilePath) {
    if (filtered.length < 3) {
      console.error(help);
      process.exit(1);
    }
    [repo, agent, title] = filtered.slice(0, 3);
    try {
      body = readFileSync(bodyFilePath, "utf-8").trim();
    } catch (e) {
      if (e.code === "ENOENT") {
        console.error(`Error: body file not found: ${bodyFilePath}`);
        process.exit(1);
      }
      throw e;
    }
  } else {
    if (filtered.length < 2) {
      console.error(help);
      process.exit(1);
    }
    [repo, agent, title, body] = filtered.slice(0, 4);
  }

  if (!REPO_PATTERN.test(repo)) {
    const inferred = getOriginRepo();
    if (!inferred) {
      console.error(help);
      process.exit(1);
    }
    repo = inferred;
    agent = filtered[0]?.toLowerCase();
    title = filtered[1];
    body = filtered[2] ?? body;
  }

  validateRepo(repo);

  if (!["cursor", "claude"].includes(agent?.toLowerCase())) {
    console.error(`Error: agent must be "cursor" or "claude", got "${agent}"`);
    process.exit(1);
  }
  agent = agent.toLowerCase();

  const templateContent = resolveIssueTemplate(templatePath, noTemplate);
  let finalBody = buildIssueBody(templateContent, body || null);

  if (!finalBody && !dryRun) {
    finalBody = editBodyInteractively(templateContent);
  } else if (!finalBody && dryRun) {
    console.error("No body or template – would open editor to fill in interactively");
  }

  const comment = `${AGENT_MENTIONS[agent]} please go and build this.`;

  const issueNumber = createIssue(repo, title, finalBody, agent, dryRun);

  if (issueNumber) {
    if (!noComment) {
      addComment(repo, issueNumber, comment, dryRun);
    }
    const url = `https://github.com/${repo}/issues/${issueNumber}`;
    console.log(url);
    if (!dryRun && !noComment) {
      console.error(`Commented: ${comment}`);
    }
  } else if (dryRun) {
    if (!noComment) {
      addComment(null, null, comment, true);
    }
    console.error("(dry run – no issue created)");
  } else {
    console.error("Created issue but could not parse issue number for comment.");
    process.exit(1);
  }
}

try {
  main();
} catch (e) {
  console.error(`\x1b[31merror\x1b[0m ${e.message}`);
  process.exit(1);
}
