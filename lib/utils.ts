import { execSync } from "child_process";
import type { PRReviewComment } from "./types.js";
import { getApiProvider } from "./api-provider.js";

/** True if the comment was posted by a bot/automated account. */
export function isBotComment(comment: PRReviewComment): boolean {
  const type = comment.user?.type;
  if (type === "Bot") return true;
  const login = (comment.user?.login ?? "").toLowerCase();
  return login.endsWith("-bot") || login.endsWith("[bot]");
}

/**
 * Detect the GitHub repository from the git remote origin URL.
 * @returns Repository in "owner/name" format, or null if not detectable
 */
export function getOriginRepo(): string | null {
  const provider = getApiProvider();
  if (provider?.getOriginRepo) {
    return provider.getOriginRepo();
  }
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const match = url.match(/github\.com[:/]([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Wrap text in an OSC 8 hyperlink escape sequence (no-op when stdout is not a TTY). */
export function hyperlink(url: string, text: string): string {
  if (!process.stdout.isTTY) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/**
 * Get the current terminal width in columns.
 * @returns Number of columns, defaulting to 80 if not available
 */
export function getTerminalColumns(): number {
  return process.stdout.columns || 80;
}
