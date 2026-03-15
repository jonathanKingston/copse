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

export function getTerminalColumns(): number {
  return process.stdout.columns || 80;
}

/**
 * Like Promise.all(items.map(fn)), but limits the number of concurrent
 * invocations to `concurrency`.  Each item is processed exactly once and
 * results are returned in the same order as the input array.
 *
 * If any task rejects, the remaining in-flight tasks are allowed to settle
 * but no new tasks are started and the first rejection is propagated.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown = undefined;
  let hasError = false;

  async function worker(): Promise<void> {
    while (nextIndex < items.length && !hasError) {
      const idx = nextIndex++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);

  if (hasError) {
    throw firstError;
  }
  return results;
}
