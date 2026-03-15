/**
 * Loads copse config from .copserc (JSON).
 * Searches in order:
 *   1. ~/.copserc (global config)
 *   2. .copserc in cwd or parent directories (local config)
 * Format: { "repos": ["owner/name", ...] }
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { getApiProvider } from "./api-provider.js";

const CONFIG_FILENAME = ".copserc";
const CONFIG_TTL_MS = 30_000; // 30 seconds

interface CachedConfig {
  config: Copserc | null;
  timestamp: number;
  cwd: string;
}

let cachedEntry: CachedConfig | null = null;

/**
 * Clears the config cache. Useful for testing or when you know the
 * config file has changed and want to force a re-read.
 */
export function clearConfigCache(): void {
  cachedEntry = null;
}

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

export function loadConfig(cwd: string = process.cwd()): Copserc | null {
  const provider = getApiProvider();
  if (provider?.loadConfig) {
    return provider.loadConfig(cwd);
  }

  const now = Date.now();
  if (cachedEntry && cachedEntry.cwd === cwd && now - cachedEntry.timestamp < CONFIG_TTL_MS) {
    return cachedEntry.config;
  }

  const homeConfig = join(homedir(), CONFIG_FILENAME);
  const globalConfig = loadConfigFromPath(homeConfig);
  if (globalConfig) {
    cachedEntry = { config: globalConfig, timestamp: now, cwd };
    return globalConfig;
  }

  const configDir = findConfigDir(cwd);
  if (!configDir) {
    cachedEntry = { config: null, timestamp: now, cwd };
    return null;
  }

  const result = loadConfigFromPath(join(configDir, CONFIG_FILENAME));
  cachedEntry = { config: result, timestamp: now, cwd };
  return result;
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
