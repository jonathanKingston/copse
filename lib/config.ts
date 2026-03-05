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

const CONFIG_FILENAME = ".copserc";

export interface Copserc {
  repos?: string[];
  commentTemplates?: string;
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
    if (parsed && typeof parsed === "object" && "repos" in parsed) {
      const repos = (parsed as Copserc).repos;
      if (Array.isArray(repos) && repos.every((r) => typeof r === "string")) {
        return parsed as Copserc;
      }
    }
  } catch {
    // Invalid JSON or missing
  }
  return null;
}

export function loadConfig(cwd: string = process.cwd()): Copserc | null {
  const homeConfig = join(homedir(), CONFIG_FILENAME);
  const globalConfig = loadConfigFromPath(homeConfig);
  if (globalConfig) return globalConfig;

  const configDir = findConfigDir(cwd);
  if (!configDir) return null;

  return loadConfigFromPath(join(configDir, CONFIG_FILENAME));
}

export function getConfiguredRepos(cwd: string = process.cwd()): string[] | null {
  const config = loadConfig(cwd);
  if (!config?.repos || config.repos.length === 0) return null;
  return config.repos;
}
