/**
 * Loads copse config from .copserc (JSON) in cwd or parent directories.
 * Format: { "repos": ["owner/name", ...] }
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const CONFIG_FILENAME = ".copserc";

export interface CommentTemplate {
  label: string;
  message: string;
}

export interface Copserc {
  repos?: string[];
  commentTemplates?: CommentTemplate[];
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
    if (parsed && typeof parsed === "object") {
      const config = parsed as Copserc;
      
      if ("repos" in config) {
        if (!Array.isArray(config.repos) || !config.repos.every((r) => typeof r === "string")) {
          return null;
        }
      }
      
      if ("commentTemplates" in config || "repos" in config) {
        return config;
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

export function getCommentTemplates(cwd: string = process.cwd()): CommentTemplate[] | null {
  const config = loadConfig(cwd);
  if (!config?.commentTemplates || config.commentTemplates.length === 0) return null;
  
  const isValid = config.commentTemplates.every(
    (t) =>
      t &&
      typeof t === "object" &&
      typeof t.label === "string" &&
      typeof t.message === "string" &&
      t.label.trim() !== "" &&
      t.message.trim() !== ""
  );
  
  if (!isValid) return null;
  return config.commentTemplates;
}
