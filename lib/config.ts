/**
 * Loads copse config from .copserc (JSON).
 * Searches in order:
 *   1. ~/.copserc (global config)
 *   2. .copserc in cwd or parent directories (local config)
 * Format: { "repos": ["owner/name", ...] }
 * 
 * Comment templates are loaded from ~/.copse/comment-templates/*.md files
 * with frontmatter for the label and body for the message.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { getApiProvider } from "./api-provider.js";

const CONFIG_FILENAME = ".copserc";
const COMMENT_TEMPLATES_DIR = join(homedir(), ".copse", "comment-templates");

export interface CommentTemplate {
  label: string;
  message: string;
}

export interface Copserc {
  repos?: string[];
  commentTemplates?: string;
  cursorApiKey?: string;
  /** Poll interval in milliseconds for the TUI/web dashboard refresh cycle.
   *  Higher values reduce GitHub API usage. Default: 60000 (60s). */
  pollIntervalMs?: number;
}

function findConfigDir(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve("/");
  while (dir !== root) {
    const path = join(dir, CONFIG_FILENAME);
    if (existsSync(path)) return dir;
    dir = resolve(dir, "..");
  }
  return null;
}

function loadConfigFromPath(configPath: string): Copserc | null {
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;

    const config = parsed as Copserc;
    const hasRepos =
      !("repos" in config) ||
      (Array.isArray(config.repos) && config.repos.every((r) => typeof r === "string"));
    const hasCommentTemplates =
      !("commentTemplates" in config) || typeof config.commentTemplates === "string";
    const hasCursorApiKey =
      !("cursorApiKey" in config) || typeof config.cursorApiKey === "string";
    const hasPollInterval =
      !("pollIntervalMs" in config) || typeof config.pollIntervalMs === "number";

    if (hasRepos && hasCommentTemplates && hasCursorApiKey && hasPollInterval) {
      return config;
    }
  } catch {
    // Invalid JSON or missing
  }
  return null;
}

export function loadConfig(cwd: string = process.cwd()): Copserc | null {
  const provider = getApiProvider();
  if (provider?.loadConfig) {
    return provider.loadConfig(cwd);
  }
  const homeConfig = join(homedir(), CONFIG_FILENAME);
  const globalConfig = loadConfigFromPath(homeConfig);
  if (globalConfig) return globalConfig;

  const configDir = findConfigDir(cwd);
  if (!configDir) return null;

  return loadConfigFromPath(join(configDir, CONFIG_FILENAME));
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 10_000;

let _cachedPollInterval: number | null = null;

/** Returns the poll interval in ms from .copserc `pollIntervalMs`, or 60s default.
 *  Minimum is 10s to avoid hammering the API. */
export function getWatchIntervalMs(): number {
  if (_cachedPollInterval !== null) return _cachedPollInterval;
  const config = loadConfig();
  if (config?.pollIntervalMs && config.pollIntervalMs >= MIN_POLL_INTERVAL_MS) {
    _cachedPollInterval = config.pollIntervalMs;
  } else {
    _cachedPollInterval = DEFAULT_POLL_INTERVAL_MS;
  }
  return _cachedPollInterval;
}

export function getConfiguredRepos(cwd: string = process.cwd()): string[] | null {
  const provider = getApiProvider();
  if (provider?.getConfiguredRepos) {
    return provider.getConfiguredRepos(cwd);
  }
  const config = loadConfig(cwd);
  if (!config?.repos || config.repos.length === 0) return null;
  return config.repos;
}

function stripFrontmatter(content: string): { label: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { label: null, body: content.trim() };
  
  const frontmatter = match[1];
  const body = match[2].trim();
  
  const labelMatch = frontmatter.match(/^label:\s*(.+)$/m);
  const label = labelMatch ? labelMatch[1].trim() : null;
  
  return { label, body };
}

export function getCommentTemplates(): CommentTemplate[] | null {
  if (!existsSync(COMMENT_TEMPLATES_DIR)) return null;
  
  try {
    const stat = statSync(COMMENT_TEMPLATES_DIR);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  
  const templatesDir = COMMENT_TEMPLATES_DIR;
  
  try {
    const files = readdirSync(templatesDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    
    if (files.length === 0) return null;
    
    const templates: CommentTemplate[] = [];
    
    for (const file of files) {
      const content = readFileSync(join(templatesDir, file), "utf-8");
      const { label, body } = stripFrontmatter(content);
      
      if (!label || !body) continue;
      
      templates.push({ label, message: body });
    }
    
    return templates.length > 0 ? templates : null;
  } catch {
    return null;
  }
}
