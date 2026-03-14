export interface StandardFlags {
  dryRun: boolean;
  all: boolean;
  mineOnly: boolean;
}

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

export function parseBaseOption(args: string[], currentIndex: number): string {
  const value = args[currentIndex + 1];
  if (!value) {
    throw new Error("--base requires a value");
  }
  return value;
}

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

export function calculateSinceDate(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}
