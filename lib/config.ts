/**
 * Loads copse config from .copserc (JSON) in cwd or parent directories.
 * Format: { "repos": ["owner/name", ...] }
 * 
 * Comment templates are loaded from ~/.copse/comment-templates/*.md files
 * with frontmatter for the label and body for the message.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const CONFIG_FILENAME = ".copserc";
const COMMENT_TEMPLATES_DIR = join(homedir(), ".copse", "comment-templates");

export interface CommentTemplate {
  label: string;
  message: string;
}

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
    if (parsed && typeof parsed === "object") {
      const config = parsed as Copserc;
      
      if ("repos" in config) {
        if (!Array.isArray(config.repos) || !config.repos.every((r) => typeof r === "string")) {
          return null;
        }
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
