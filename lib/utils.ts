import { execSync } from "child_process";
import type { PRReviewComment } from "./types.js";

/** True if the comment was posted by a bot/automated account. */
export function isBotComment(comment: PRReviewComment): boolean {
  const type = comment.user?.type;
  if (type === "Bot") return true;
  const login = (comment.user?.login ?? "").toLowerCase();
  return login.endsWith("-bot") || login.endsWith("[bot]");
}

export function getOriginRepo(): string | null {
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

export function getTerminalColumns(): number {
  return process.stdout.columns || 80;
}
