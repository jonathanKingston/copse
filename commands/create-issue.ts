/**
 * Creates a GitHub issue and comments on it to instruct the specified agent to build it.
 *
 * Usage: create-issue [repo] [title] [body] [agent] [options]
 *
 * Arguments:
 *   repo   - GitHub repo in owner/name format (e.g. acme/cool-project).
 *            Omit when run inside a git repo to use origin remote.
 *   title  - Issue title (omit to be prompted interactively)
 *   body   - Optional issue body (omit to open editor with template for interactive fill-in)
 *   agent  - "cursor", "claude", or "copilot" (default: cursor) – the agent to instruct
 *
 * Options:
 *   --body-file PATH  Read issue body from file
 *   --template PATH   Path to issue template (default: look in .github/issue_template.md, etc.)
 *   --no-template    Skip template, use only body
 *   --no-comment     Do not add the agent instruction comment
 *   --pr NUMBER      Update an existing PR branch instead of creating a new one (Cursor API only)
 *   --dry-run        Show what would be created without creating
 *
 * Template lookup (first found): .github/issue_template.md,
 * .github/ISSUE_TEMPLATE/issue_template.md, issue_template.md, docs/issue_template.md,
 * or first .md in .github/ISSUE_TEMPLATE/. YAML frontmatter is stripped.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFileSync, execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { REPO_PATTERN, validateRepo, validateAgent } from "../lib/gh.js";
import { getOriginRepo } from "../lib/utils.js";
import { loadConfig } from "../lib/config.js";
import { launchAgentForPrUrl, launchAgentForRepository } from "../lib/cursor-api.js";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

const DEFAULT_ISSUE_TEMPLATE_PATHS = [
  ".github/issue_template.md",
  ".github/ISSUE_TEMPLATE/issue_template.md",
  "issue_template.md",
  "docs/issue_template.md",
];

const AGENT_MENTIONS: Record<string, string> = {
  cursor: "@cursor",
  claude: "@claude",
  copilot: "@copilot",
};

interface CommentTemplate {
  label: string;
  build: (mention: string) => string;
}

const COMMENT_TEMPLATES: CommentTemplate[] = [
  {
    label: "Research – deeply investigate the issue and report findings",
    build: (m) => `${m} please deeply research this issue. Look at the codebase and related code, and provide a thorough analysis of what's involved, what the root cause is, and what options exist.`,
  },
  {
    label: "Plan – review the code and create an implementation plan",
    build: (m) => `${m} please look at the codebase and create a detailed plan for implementing this. Don't make changes yet, just outline the approach, which files need changing, and any trade-offs.`,
  },
  {
    label: "Fix – go and build / fix this",
    build: (m) => `${m} please go and build this.`,
  },
];

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

function getFirstIssueTemplateInFolder(): string | null {
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

function resolveIssueTemplate(templatePath: string | null, noTemplate: boolean): string | null {
  if (noTemplate) return null;
  if (templatePath) {
    try {
      const content = readFileSync(resolve(templatePath), "utf-8").trim();
      return content ? stripFrontmatter(content) : null;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        return null;
      }
    }
  }
  return getFirstIssueTemplateInFolder();
}

function buildIssueBody(templateContent: string | null, userBody: string | null): string | undefined {
  if (userBody) {
    return templateContent
      ? `${templateContent}\n\n---\n\n${userBody}`
      : userBody;
  }
  return templateContent || undefined;
}

function editBodyInteractively(templateContent: string | null): string {
  if (!process.stdin.isTTY) {
    throw new Error("No body provided and not running interactively. Use --body or --body-file.");
  }
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  const tmpPath = join(tmpdir(), `create-issue-${Date.now()}.md`);
  try {
    writeFileSync(tmpPath, templateContent || "", "utf-8");
    execSync(editor + " " + JSON.stringify(tmpPath), { stdio: "inherit", shell: "/bin/sh" });
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

function createIssue(repo: string, title: string, body: string | undefined, dryRun: boolean): number | null {
  if (dryRun) {
    console.error(`Would create issue: "${title}"`);
    if (body) console.error(`  Body: ${body.slice(0, 80)}${body.length > 80 ? "..." : ""}`);
    return null;
  }

  const args = ["issue", "create", "--repo", repo, "--title", title];
  if (body) {
    args.push("--body-file", "-");
  } else {
    args.push("--body", ".");
  }

  const out = execFileSync("gh", args, {
    encoding: "utf-8",
    ...(body ? { input: body } : {}),
  });
  const match = out.trim().match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function addComment(repo: string, issueNumber: number, comment: string, dryRun: boolean): void {
  if (dryRun) {
    console.error(`Would add comment: "${comment.slice(0, 80)}${comment.length > 80 ? "..." : ""}"`);
    return;
  }
  execFileSync("gh", ["issue", "comment", String(issueNumber), "--repo", repo, "--body", comment], {
    encoding: "utf-8",
  });
}

function stripAgentMention(comment: string, agent: string): string {
  const mention = `@${agent}`;
  const trimmed = comment.trim();
  if (trimmed.toLowerCase().startsWith(mention.toLowerCase())) {
    return trimmed.slice(mention.length).trimStart();
  }
  return trimmed;
}

async function sendInstructionViaCursorApi(
  repo: string,
  issueNumber: number,
  agent: string,
  comment: string,
  cursorApiKey: string,
  dryRun: boolean,
  targetPr: number | null
): Promise<void> {
  const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
  const instruction = stripAgentMention(comment, agent);
  const prompt = `${instruction}\n\nIssue: ${issueUrl}`;

  if (targetPr) {
    const prUrl = `https://github.com/${repo}/pull/${targetPr}`;
    if (dryRun) {
      console.error(`Would launch Cursor agent targeting ${prUrl} with prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}"`);
      return;
    }
    const id = await launchAgentForPrUrl(cursorApiKey, prUrl, prompt);
    console.error(`${ANSI.green}Cursor agent launched targeting PR #${targetPr}: ${id}${ANSI.reset}`);
    return;
  }

  if (dryRun) {
    console.error(`Would launch Cursor agent for ${issueUrl} with prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}"`);
    return;
  }

  const id = await launchAgentForRepository(
    cursorApiKey,
    `https://github.com/${repo}`,
    prompt,
    { autoCreatePr: true, openAsCursorGithubApp: true }
  );
  console.error(`${ANSI.green}Cursor agent launched: ${id}${ANSI.reset}`);
}

async function promptTitle(rl: readline.Interface): Promise<string> {
  for (;;) {
    const raw = await rl.question(`${ANSI.bold}Issue title:${ANSI.reset} `);
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
    console.error(`${ANSI.red}Title cannot be empty.${ANSI.reset}`);
  }
}

async function promptComment(rl: readline.Interface, mention: string): Promise<string | null> {
  console.error(`\n${ANSI.bold}Select comment for the agent:${ANSI.reset}`);
  console.error(`  ${ANSI.cyan}[0]${ANSI.reset} No comment`);
  for (let i = 0; i < COMMENT_TEMPLATES.length; i++) {
    console.error(`  ${ANSI.cyan}[${i + 1}]${ANSI.reset} ${COMMENT_TEMPLATES[i].label}`);
  }
  console.error(`  ${ANSI.cyan}[${COMMENT_TEMPLATES.length + 1}]${ANSI.reset} Custom – type your own message`);

  for (;;) {
    const raw = await rl.question(`\n${ANSI.bold}Choice (0-${COMMENT_TEMPLATES.length + 1}):${ANSI.reset} `);
    const choice = parseInt(raw.trim(), 10);

    if (choice === 0) return null;

    if (choice >= 1 && choice <= COMMENT_TEMPLATES.length) {
      const comment = COMMENT_TEMPLATES[choice - 1].build(mention);
      console.error(`${ANSI.dim}→ ${comment}${ANSI.reset}`);
      return comment;
    }

    if (choice === COMMENT_TEMPLATES.length + 1) {
      const custom = await rl.question(`${ANSI.bold}Comment:${ANSI.reset} `);
      const trimmed = custom.trim();
      if (!trimmed) {
        console.error(`${ANSI.red}Empty comment, try again.${ANSI.reset}`);
        continue;
      }
      const comment = `${mention} ${trimmed}`;
      console.error(`${ANSI.dim}→ ${comment}${ANSI.reset}`);
      return comment;
    }

    console.error("Invalid choice.");
  }
}

const AGENTS = ["cursor", "claude", "copilot"];
function isAgent(s: string | undefined): boolean {
  return !!s && AGENTS.includes(s.toLowerCase());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const noComment = args.includes("--no-comment");
  const noTemplate = args.includes("--no-template");
  const bodyFileIdx = args.indexOf("--body-file");
  const bodyFilePath = bodyFileIdx >= 0 ? args[bodyFileIdx + 1] : null;
  const templateIdx = args.indexOf("--template");
  const templatePath = templateIdx >= 0 ? args[templateIdx + 1] : null;
  const prIdx = args.indexOf("--pr");
  const targetPrRaw = prIdx >= 0 ? args[prIdx + 1] : null;
  const targetPr = targetPrRaw ? parseInt(targetPrRaw, 10) : null;
  if (prIdx >= 0 && (!Number.isInteger(targetPr) || !targetPr || targetPr <= 0)) {
    console.error("Error: --pr requires a valid pull request number");
    process.exit(1);
  }
  const filtered = args.filter((a, i) => {
    if (["--dry-run", "--no-comment", "--no-template", "--body-file", "--template", "--pr"].includes(a)) return false;
    if (bodyFileIdx >= 0 && i === bodyFileIdx + 1) return false;
    if (templateIdx >= 0 && i === templateIdx + 1) return false;
    if (prIdx >= 0 && i === prIdx + 1) return false;
    return true;
  });

  const help = `Usage: create-issue [repo] [title] [body] [agent] [options]

  repo         GitHub repo in owner/name format (e.g. acme/cool-project).
               Omit when run inside a git repo to use origin remote.
  title        Issue title (omit to be prompted)
  body         Optional issue body (omit to open editor)
  agent        "cursor", "claude", or "copilot" (default: cursor)

Options:
  --body-file PATH   Read issue body from file
  --template PATH    Path to issue template (default: look in .github/issue_template.md,
                     .github/ISSUE_TEMPLATE/issue_template.md, issue_template.md, docs/issue_template.md)
  --no-template      Skip template, use only body
  --no-comment       Do not add the agent instruction comment
  --pr NUMBER        Update an existing PR branch instead of creating a new one (Cursor API only)
  --dry-run          Show what would be created without creating

Examples:
  create-issue                                     # prompt for everything
  create-issue "Add dark mode"                     # infer repo from origin
  create-issue acme/cool-project "Add dark mode"
  create-issue acme/cool-project "Fix login bug" "User cannot log in" claude
  create-issue acme/cool-project "Implement feature X" --body-file spec.md
  create-issue acme/cool-project "Add feature" --no-comment
`;

  let repo: string;
  let title: string | undefined;
  let body: string | undefined;
  let agent: string;

  const inferredRepo = !REPO_PATTERN.test(filtered[0] ?? "") ? getOriginRepo() : null;

  if (inferredRepo) {
    repo = inferredRepo;
    const [a, b, c] = filtered;
    title = a && !isAgent(a) ? a : undefined;

    if (!title) {
      agent = isAgent(a) ? a.toLowerCase() : "cursor";
    } else if (filtered.length === 1) {
      agent = "cursor";
    } else if (filtered.length === 2) {
      body = isAgent(b) ? undefined : b;
      agent = isAgent(b) ? b.toLowerCase() : "cursor";
    } else {
      body = isAgent(b) ? undefined : b;
      agent = isAgent(c) ? c.toLowerCase() : "cursor";
    }

    if (bodyFilePath) {
      try {
        body = readFileSync(bodyFilePath, "utf-8").trim();
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          console.error(`Error: body file not found: ${bodyFilePath}`);
          process.exit(1);
        }
        throw e;
      }
    }
  } else {
    if (filtered.length < 1) {
      console.error(help);
      process.exit(1);
    }
    repo = filtered[0];
    const rest = filtered.slice(1);
    const last = rest[rest.length - 1]?.toLowerCase();
    const isLastAgent = isAgent(last);

    if (rest.length === 0) {
      agent = "cursor";
    } else if (rest.length === 1) {
      if (isLastAgent) {
        agent = last;
      } else {
        title = rest[0];
        agent = "cursor";
      }
    } else if (rest.length === 2) {
      title = rest[0];
      if (isLastAgent) {
        agent = last;
      } else {
        body = rest[1];
        agent = "cursor";
      }
    } else {
      title = rest[0];
      body = rest[1];
      agent = isLastAgent ? last : "cursor";
    }

    if (bodyFilePath) {
      try {
        body = readFileSync(bodyFilePath, "utf-8").trim();
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          console.error(`Error: body file not found: ${bodyFilePath}`);
          process.exit(1);
        }
        throw e;
      }
    }
  }

  validateRepo(repo);
  agent = validateAgent(agent);
  const config = loadConfig();
  const cursorApiKey = config?.cursorApiKey?.trim() || null;
  const shouldUseCursorApi = agent === "cursor" && cursorApiKey !== null;

  if (targetPr && !shouldUseCursorApi) {
    console.error("Error: --pr requires the Cursor API (agent=cursor with cursorApiKey configured)");
    process.exit(1);
  }

  const isInteractive = stdout.isTTY;

  if (!title && !isInteractive) {
    throw new Error("No title provided and not running interactively.");
  }

  let rl: readline.Interface | null = null;
  if (isInteractive && (!title || (!noComment && !dryRun))) {
    rl = readline.createInterface({ input: stdin, output: stdout });
  }

  try {
    if (!title) {
      title = await promptTitle(rl!);
    }

    const templateContent = resolveIssueTemplate(templatePath, noTemplate);
    let finalBody = buildIssueBody(templateContent, body || null);

    if (!finalBody && !dryRun) {
      finalBody = editBodyInteractively(templateContent);
    } else if (!finalBody && dryRun) {
      console.error("No body or template – would open editor to fill in interactively");
    }

    const mention = AGENT_MENTIONS[agent];
    let comment: string | null = null;

    if (!noComment) {
      if (dryRun) {
        comment = COMMENT_TEMPLATES[2].build(mention);
      } else if (rl) {
        comment = await promptComment(rl, mention);
      } else {
        comment = COMMENT_TEMPLATES[2].build(mention);
      }
    }

    const issueNumber = createIssue(repo, title, finalBody, dryRun);

    if (issueNumber) {
      if (comment) {
        if (shouldUseCursorApi) {
          await sendInstructionViaCursorApi(repo, issueNumber, agent, comment, cursorApiKey!, dryRun, targetPr);
        } else {
          addComment(repo, issueNumber, comment, dryRun);
        }
      }
      const url = `https://github.com/${repo}/issues/${issueNumber}`;
      console.log(url);
      if (!dryRun && comment) {
        if (shouldUseCursorApi && targetPr) {
          console.error(`${ANSI.green}Sent instruction to Cursor API targeting PR #${targetPr}.${ANSI.reset}`);
        } else if (shouldUseCursorApi) {
          console.error(`${ANSI.green}Sent instruction to Cursor API (instead of issue comment).${ANSI.reset}`);
        } else {
          console.error(`${ANSI.green}Commented: ${comment}${ANSI.reset}`);
        }
      }
    } else if (dryRun) {
      if (comment) {
        if (shouldUseCursorApi) {
          console.error(`Would send instruction to Cursor API: "${comment}"`);
        } else {
          console.error(`Would add comment: "${comment}"`);
        }
      }
      console.error("(dry run – no issue created)");
    } else {
      console.error("Created issue but could not parse issue number for comment.");
      process.exit(1);
    }
  } finally {
    rl?.close();
  }
}

main().catch((e: unknown) => {
  console.error(`\x1b[31merror\x1b[0m ${(e as Error).message}`);
  process.exit(1);
});
