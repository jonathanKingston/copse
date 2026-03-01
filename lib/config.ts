/**
 * Loads copse config from .copserc (JSON) in cwd or parent directories.
 * Format: { "repos": ["owner/name", ...] }
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const CONFIG_FILENAME = ".copserc";

export interface Copserc {
  repos?: string[];
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

export function loadConfig(cwd: string = process.cwd()): Copserc | null {
  const configDir = findConfigDir(cwd);
  if (!configDir) return null;

  try {
    const raw = readFileSync(join(configDir, CONFIG_FILENAME), "utf-8");
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

export function getConfiguredRepos(cwd: string = process.cwd()): string[] | null {
  const config = loadConfig(cwd);
  if (!config?.repos || config.repos.length === 0) return null;
  return config.repos;
}
