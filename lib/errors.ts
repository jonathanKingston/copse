/**
 * Structured error types for copse.
 *
 * These replace generic `new Error(...)` throws with typed classes so that
 * callers can discriminate errors programmatically (via `instanceof`) rather
 * than parsing message strings.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/** Base class for all copse-specific errors. */
export class CopseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopseError";
  }
}

// ---------------------------------------------------------------------------
// GitHub / gh CLI errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a `gh` CLI invocation fails for reasons other than
 * not-found / not-authenticated (which have their own classes in gh.ts).
 */
export class GitHubApiError extends CopseError {
  /** The stderr output from the failed gh command, if available. */
  readonly stderr: string;
  /** The gh CLI arguments that were passed. */
  readonly ghArgs: string[];

  constructor(message: string, opts: { stderr?: string; ghArgs?: string[] } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.stderr = opts.stderr ?? "";
    this.ghArgs = opts.ghArgs ?? [];
  }
}

// ---------------------------------------------------------------------------
// Configuration errors
// ---------------------------------------------------------------------------

/** Thrown when a .copserc file cannot be loaded or has invalid structure. */
export class ConfigError extends CopseError {
  /** Filesystem path of the offending config file, if known. */
  readonly configPath: string | undefined;

  constructor(message: string, configPath?: string) {
    super(message);
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

/** Thrown when user-supplied CLI arguments or other inputs are invalid. */
export class ValidationError extends CopseError {
  /** The name of the field / flag that failed validation, if applicable. */
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Timeout errors
// ---------------------------------------------------------------------------

/** Thrown when a subprocess (e.g. gh) exceeds its allowed execution time. */
export class TimeoutError extends CopseError {
  /** Duration in milliseconds that was exceeded. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
