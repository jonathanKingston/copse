/**
 * Global verbose/debug flag for logging gh subprocess commands.
 *
 * The flag is set either programmatically via {@link setVerbose} or by
 * reading the `COPSE_VERBOSE` environment variable (set by the CLI entry
 * point when `--verbose` is passed).
 */

let _verbose = false;

export function isVerbose(): boolean {
  return _verbose;
}

export function setVerbose(on: boolean): void {
  _verbose = on;
}

/** Initialise from environment — called once at process startup. */
export function initVerboseFromEnv(): void {
  if (process.env.COPSE_VERBOSE === "1") {
    _verbose = true;
  }
}

/**
 * Log a gh command invocation to stderr so it doesn't interfere with
 * stdout output consumed by callers.
 */
export function logGhCall(args: readonly string[], label: string = "gh"): void {
  if (!_verbose) return;
  const cmdStr = [label, ...args].map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
  process.stderr.write(`[verbose] exec: ${cmdStr}\n`);
}

/**
 * Log timing information for a completed gh call.
 */
export function logGhTiming(args: readonly string[], durationMs: number, label: string = "gh"): void {
  if (!_verbose) return;
  const sub = args.slice(0, 2).join(" ");
  process.stderr.write(`[verbose] ${label} ${sub} completed in ${durationMs}ms\n`);
}
