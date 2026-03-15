/**
 * Load and scaffold comment templates from a directory of .md files.
 * Default path: ~/.copse/comment-templates
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getApiProvider } from "./api-provider.js";

const DEFAULT_TEMPLATES_DIR = ".copse/comment-templates";

const STARTER_TEMPLATES: Record<string, string> = {
  "please-fix.md": "Please fix this.",
  "add-tests.md": "Could you add tests for this?",
  "review-again.md": "Please review again after the changes.",
};

/** Resolve path, expanding ~ to homedir. */
export function expandTildePath(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return join(homedir(), path.slice(1) || "");
  }
  return path;
}

/** Get default template directory path: ~/.copse/comment-templates */
export function getDefaultTemplatesDir(): string {
  return join(homedir(), DEFAULT_TEMPLATES_DIR);
}

/** Create directory and write starter template files. */
export function scaffoldTemplates(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
  for (const [filename, content] of Object.entries(STARTER_TEMPLATES)) {
    writeFileSync(join(dirPath, filename), content.trimEnd() + "\n", "utf-8");
  }
}

/**
 * Load templates from directory. Returns Map of label (filename without .md) -> body.
 * Returns empty Map if directory doesn't exist or has no .md files.
 * Does NOT prompt or scaffold—caller handles that.
 */
export function loadTemplates(dirPath: string): Map<string, string> {
  const provider = getApiProvider();
  if (provider?.loadTemplates) {
    return provider.loadTemplates(dirPath);
  }
  const resolved = expandTildePath(dirPath);
  if (!existsSync(resolved)) {
    return new Map();
  }
  let entries: string[];
  try {
    entries = readdirSync(resolved);
  } catch {
    return new Map();
  }
  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
  const result = new Map<string, string>();
  for (const f of mdFiles) {
    const label = f.slice(0, -3);
    try {
      const body = readFileSync(join(resolved, f), "utf-8").trim();
      result.set(label, body);
    } catch {
      // Skip unreadable files
    }
  }
  return result;
}

/** Resolve templates path: --templates flag > .copserc commentTemplates > default. */
export function resolveTemplatesPath(
  templatesFromFlag: string | null,
  templatesFromConfig: string | null
): string {
  if (templatesFromFlag) return expandTildePath(templatesFromFlag);
  if (templatesFromConfig) return expandTildePath(templatesFromConfig);
  return getDefaultTemplatesDir();
}

/** True if directory is missing or contains no .md files. */
export function needsScaffold(dirPath: string): boolean {
  const resolved = expandTildePath(dirPath);
  if (!existsSync(resolved)) return true;
  try {
    const entries = readdirSync(resolved);
    const hasMd = entries.some((f) => f.endsWith(".md"));
    return !hasMd;
  } catch {
    return true;
  }
}
