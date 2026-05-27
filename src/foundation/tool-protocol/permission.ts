export interface PermissionChecker {
  /** Throws if read not allowed */
  checkRead(targetPath: string): void;
  /** Throws if write not allowed */
  checkWrite(targetPath: string): void;
  /** Resolves relative path + checks operation; returns absolute path */
  resolveAndCheck(relativePath: string, operation: 'read' | 'write'): string;
}
