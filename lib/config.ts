/**
 * Loads copse config from .copserc (JSON) and environment variables.
 *
 * Environment variables (take precedence over .copserc values):
 *   - COPSE_REPOS: comma-separated list of repos (e.g. "owner/repo1,owner/repo2")
 *   - COPSE_CURSOR_API_KEY: Cursor API key
 *   - COPSE_COMMENT_TEMPLATES: path to comment templates directory
 *
 * File-based config searches in order:
 *   1. ~/.copserc (global config)
 *   2. .copserc in cwd or parent directories (local config)
 * Format: { "repos": ["owner/name", ...] }
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { getApiProvider } from "./api-provider.js";

const CONFIG_FILENAME = ".copserc";

export interface Copserc {
  repos?: string[];
  commentTemplates?: string;
  cursorApiKey?: string;
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

    if (hasRepos && hasCommentTemplates && hasCursorApiKey) {
      return config;
    }
  } catch {
    // Invalid JSON or missing
  }
  return null;
}

export function loadEnvConfig(): Copserc {
  const env: Copserc = {};
  const reposRaw = process.env.COPSE_REPOS;
  if (reposRaw) {
    env.repos = reposRaw.split(",").map((r) => r.trim()).filter(Boolean);
  }
  if (process.env.COPSE_CURSOR_API_KEY) {
    env.cursorApiKey = process.env.COPSE_CURSOR_API_KEY;
  }
  if (process.env.COPSE_COMMENT_TEMPLATES) {
    env.commentTemplates = process.env.COPSE_COMMENT_TEMPLATES;
  }
  return env;
}

export function loadConfig(cwd: string = process.cwd()): Copserc | null {
  const provider = getApiProvider();
  if (provider?.loadConfig) {
    return provider.loadConfig(cwd);
  }

  const envConfig = loadEnvConfig();

  const homeConfig = join(homedir(), CONFIG_FILENAME);
  let fileConfig = loadConfigFromPath(homeConfig);
  if (!fileConfig) {
    const configDir = findConfigDir(cwd);
    if (configDir) {
      fileConfig = loadConfigFromPath(join(configDir, CONFIG_FILENAME));
    }
  }

  // Merge: env vars take precedence over file config
  const merged: Copserc = { ...fileConfig, ...envConfig };

  // Return null only if nothing was found
  if (!merged.repos && !merged.cursorApiKey && !merged.commentTemplates) {
    return null;
  }

  return merged;
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
