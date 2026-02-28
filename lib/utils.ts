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
