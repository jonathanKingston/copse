export interface StandardFlags {
  dryRun: boolean;
  all: boolean;
  mineOnly: boolean;
}

/**
 * Parse standard CLI flags (--dry-run, --all, --mine) from argument list.
 * @param args - Raw CLI arguments
 * @returns Object containing parsed flags and remaining arguments
 */
export function parseStandardFlags(args: string[]): { flags: StandardFlags; filtered: string[] } {
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const mineOnly = !all;

  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--templates") {
      i++;
      continue;
    }
    if (["--dry-run", "--all", "--mine"].includes(args[i])) continue;
    filtered.push(args[i]);
  }

  return {
    flags: { dryRun, all, mineOnly },
    filtered,
  };
}

/**
 * Parse the --hours option value from the argument list.
 * @param args - Raw CLI arguments
 * @param currentIndex - Index of the --hours flag in the array
 * @returns The parsed hours value as a positive integer
 * @throws Error if value is missing or not a positive number
 */
export function parseHoursOption(args: string[], currentIndex: number): number {
  const value = args[currentIndex + 1];
  if (!value) {
    throw new Error("--hours requires a value");
  }
  const hours = parseInt(value, 10);
  if (Number.isNaN(hours) || hours < 1) {
    throw new Error("--hours must be a positive number");
  }
  return hours;
}

/**
 * Parse the --base option value from the argument list.
 * @param args - Raw CLI arguments
 * @param currentIndex - Index of the --base flag in the array
 * @returns The base branch name string
 * @throws Error if value is missing
 */
export function parseBaseOption(args: string[], currentIndex: number): string {
  const value = args[currentIndex + 1];
  if (!value) {
    throw new Error("--base requires a value");
  }
  return value;
}

/**
 * Parse the --template option value from the argument list.
 * @param args - Raw CLI arguments
 * @param currentIndex - Index of the --template flag in the array
 * @returns The template name string
 * @throws Error if value is missing
 */
export function parseTemplateOption(args: string[], currentIndex: number): string {
  const value = args[currentIndex + 1];
  if (!value) {
    throw new Error("--template requires a value");
  }
  return value;
}

/** Parse --templates PATH from args. Returns path or null if not present. */
export function parseTemplatesOption(args: string[]): string | null {
  const idx = args.indexOf("--templates");
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--templates requires a value");
  }
  return value;
}

/**
 * Calculate a Date that is the given number of hours in the past.
 * @param hours - Number of hours to subtract from now
 * @returns A Date object representing that point in the past
 */
export function calculateSinceDate(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}
