/**
 * Command interface with lifecycle hooks.
 *
 * Commands that implement this interface can be executed by the command runner
 * in copse.ts, which handles the full lifecycle:
 *   1. validate(args) — parse & validate CLI arguments; throw to abort
 *   2. run(args)      — execute the command logic
 *   3. cleanup()      — always called, even when run() throws (finally)
 *
 * Commands that don't need validation or cleanup can omit those hooks.
 */

export interface Command {
  /** The command name as invoked on the CLI (e.g. "approval"). */
  name: string;

  /** One-line description shown in help output. */
  description: string;

  /**
   * Validate CLI arguments before running.
   * Throw an Error to abort with a message.
   * Called before run().
   */
  validate?(args: string[]): void | Promise<void>;

  /**
   * Execute the command.
   * Receives the raw CLI args (everything after the command name).
   */
  run(args: string[]): void | Promise<void>;

  /**
   * Cleanup hook, always called after run() completes or throws.
   * Use for releasing resources, restoring state, etc.
   */
  cleanup?(): void | Promise<void>;
}

/**
 * Runs a Command through its full lifecycle: validate → run → cleanup.
 *
 * - If validate() throws, run() is skipped but cleanup() still runs.
 * - If run() throws, cleanup() still runs and the error is re-thrown.
 * - If cleanup() itself throws, that error is reported to stderr but the
 *   original error (if any) takes priority.
 */
export async function runCommandLifecycle(
  command: Command,
  args: string[],
): Promise<void> {
  let runError: unknown = null;

  try {
    if (command.validate) {
      await command.validate(args);
    }
    await command.run(args);
  } catch (e: unknown) {
    runError = e;
  } finally {
    if (command.cleanup) {
      try {
        await command.cleanup();
      } catch (cleanupErr: unknown) {
        console.error(
          `\x1b[33mwarning\x1b[0m cleanup failed for "${command.name}": ${(cleanupErr as Error).message}`,
        );
      }
    }
  }

  if (runError) {
    throw runError;
  }
}
