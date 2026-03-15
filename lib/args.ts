export interface StandardFlags {
  dryRun: boolean;
  all: boolean;
  mineOnly: boolean;
}

export function parseStandardFlags(args: string[]): { flags: StandardFlags; filtered: string[] } {
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const mineOnly = !all;

  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--templates") {
      i++;
      continue;
    }
    if (["--dry-run", "--all", "--mine"].includes(args[i])) continue;
    filtered.push(args[i]);
  }

  return {
    flags: { dryRun, all, mineOnly },
    filtered,
  };
}

export function parseHoursOption(args: string[], currentIndex: number): number {
  const value = args[currentIndex + 1];
  if (!value) {
    throw new Error("--hours requires a value");
  }
  const hours = parseInt(value, 10);
  if (Number.isNaN(hours) || hours < 1) {
    throw new Error("--hours must be a positive number");
  }
  return hours;
}

export function parseBaseOption(args: string[], currentIndex: number): string {
  const value = args[currentIndex + 1];
  if (!value) {
    throw new Error("--base requires a value");
  }
  return value;
}

export function parseTemplateOption(args: string[], currentIndex: number): string {
  const value = args[currentIndex + 1];
  if (!value) {
    throw new Error("--template requires a value");
  }
  return value;
}

/** Parse --templates PATH from args. Returns path or null if not present. */
export function parseTemplatesOption(args: string[]): string | null {
  const idx = args.indexOf("--templates");
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--templates requires a value");
  }
  return value;
}

export function calculateSinceDate(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Shared CLI argument parser
// ---------------------------------------------------------------------------

/** Positional args extracted from the command line. */
export interface ParsedPositionals {
  /** GitHub repo in owner/name format. */
  repo: string;
  /** Agent filter ("cursor" | "claude") or null when not specified. */
  agent: string | null;
  /** Free-text query or null. */
  query: string | null;
}

/** Named options extracted from the remaining args after positionals. */
export interface ParsedOptions {
  hours: number;
  base: string;
  template: string | null;
  noTemplate: boolean;
}

/** Full result returned by {@link parseCliArgs}. */
export interface ParsedCliArgs {
  flags: StandardFlags;
  positionals: ParsedPositionals;
  options: ParsedOptions;
}

/** Configuration for {@link parseCliArgs}. */
export interface ParseCliConfig {
  /** When true, the first positional arg MUST be a repo. When false, repo is
   *  inferred via `inferRepo` if the first arg doesn't look like a repo. */
  repoRequired?: boolean;
  /** Default value for --hours (default: 24). */
  defaultHours?: number;
  /** Default value for --base (default: "main"). */
  defaultBase?: string;
  /** Default value for --template (default: null). */
  defaultTemplate?: string | null;
  /** Help text to display when args are insufficient. */
  helpText?: string;
  /** Pattern used to detect whether a positional arg is a repo.
   *  Defaults to /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/ */
  repoPattern?: RegExp;
  /** Callback to infer the repo when not provided (e.g. from git origin).
   *  Return null/undefined when inference fails. */
  inferRepo?: () => string | null | undefined;
}

const AGENTS = ["cursor", "claude"];

function isAgent(value: string): boolean {
  return AGENTS.includes(value.toLowerCase());
}

const DEFAULT_REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/**
 * Shared CLI argument parser.
 *
 * Handles the common pattern used across commands:
 *   [repo] [agent] [query] [--dry-run] [--all] [--hours N] [--base BRANCH]
 *                                        [--template PATH] [--no-template]
 *
 * When `repoRequired` is false (the default), the parser attempts to detect
 * whether the first positional arg is a repo (via repoPattern). If it isn't,
 * the repo is inferred using the `inferRepo` callback.
 */
export function parseCliArgs(
  argv: string[],
  config: ParseCliConfig = {},
): ParsedCliArgs {
  const {
    repoRequired = false,
    defaultHours = 24,
    defaultBase = "main",
    defaultTemplate = null,
    helpText,
    repoPattern = DEFAULT_REPO_PATTERN,
    inferRepo,
  } = config;

  // Step 1: extract standard boolean flags (--dry-run, --all, --mine,
  // --templates).
  const { flags, filtered } = parseStandardFlags(argv);

  // Step 2: separate positional args from named options.
  const positional: string[] = [];
  let hours = defaultHours;
  let base = defaultBase;
  let template: string | null = defaultTemplate;
  let noTemplate = false;

  for (let i = 0; i < filtered.length; i++) {
    const a = filtered[i];
    if (a === "--hours") {
      hours = parseHoursOption(filtered, i);
      i++;
    } else if (a === "--base") {
      base = parseBaseOption(filtered, i);
      i++;
    } else if (a === "--template") {
      template = parseTemplateOption(filtered, i);
      i++;
    } else if (a === "--no-template") {
      noTemplate = true;
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
    // unknown flags are silently ignored (forward-compatible)
  }

  // Step 3: resolve positionals -> repo / agent / query.
  let repo: string | undefined;
  let agent: string | null = null;
  let query: string | null = null;
  let cursor = 0; // index into positional[]

  if (repoRequired) {
    // Repo is mandatory - first positional must be provided.
    if (positional.length < 1) {
      if (helpText) {
        console.error(helpText);
        process.exit(1);
      }
      throw new Error("repo argument is required");
    }
    repo = positional[cursor++];
  } else {
    // Repo is optional - detect by pattern.
    if (positional.length >= 1 && repoPattern.test(positional[0])) {
      repo = positional[cursor++];
    } else {
      repo = (inferRepo?.() ?? undefined) as string | undefined;
      if (!repo) {
        if (helpText) {
          console.error(helpText);
          process.exit(1);
        }
        throw new Error(
          "Could not determine repo. Provide it as the first argument or run from inside a git repo.",
        );
      }
    }
  }

  // Optional agent positional.
  if (cursor < positional.length && isAgent(positional[cursor])) {
    agent = positional[cursor++].toLowerCase();
  }

  // Optional query positional (everything remaining).
  if (cursor < positional.length) {
    query = positional.slice(cursor).join(" ");
  }

  return {
    flags,
    positionals: { repo, agent, query },
    options: { hours, base, template, noTemplate },
  };
}
