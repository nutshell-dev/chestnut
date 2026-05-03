/**
 * Path permission checker contract (cross-cutting type)
 *
 * Interface defining path access policy contract.
 * Multiple impls possible (e.g., ClawPermissionChecker for claw-space sandbox).
 *
 * Owner: cross-cutting types (similar pattern to errors.ts / message.ts / paths.ts).
 * Impl: src/core/permissions/claw-permissions.ts (L4 / claw-space business rules).
 */

export interface PermissionChecker {
  /** Throws if read not allowed */
  checkRead(targetPath: string): void;
  /** Throws if write not allowed */
  checkWrite(targetPath: string): void;
  /** Resolves relative path + checks operation; returns absolute path */
  resolveAndCheck(relativePath: string, operation: 'read' | 'write'): string;
}
