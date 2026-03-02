import { execSync } from "child_process";

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
