/**
 * Wraps Commander .action handlers to handle CliError uniformly + explicit process.exit.
 *
 * Phase 916 r114 B fork (phase 885 round 2 P0):
 * - Replaces `try { ... } catch (error) { process.exitCode = handleCliError(error); }` boilerplate
 *   across 26 .action sites in src/cli/index.ts.
 * - Explicit `process.exit(code)` (vs `process.exitCode = code` + event loop drain) fixes spawn-based
 *   test 15s timeout root cause (4/10 transient fail). Event loop drain waits for pending fs/audit/timer
 *   handles to settle; in error paths these may never settle (parameter validation fails before resource
 *   construction completes), holding process open indefinitely.
 *
 * Scope:
 * - Only wraps Commander .action async handlers (audit-2026-05-16 NEW.P0.cli-exit-wrapper cluster).
 * - Does NOT replace `on('command:*')` sync handlers (B.unknown-command-handler-sync-exitcode ⚓):
 *   sync path has no IO drain race.
 */
import { handleCliError } from './errors.js';

export function withCliErrorHandling<T extends unknown[]>(
  action: (...args: T) => Promise<void> | void,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await action(...args);
    } catch (error) {
      const code = handleCliError(error);
      process.exit(code);
    }
  };
}
