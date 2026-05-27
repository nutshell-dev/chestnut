/**
 * TestProcessManager — ProcessManager subclass exposing private fields for test access.
 *
 * Use in test files instead of `new ProcessManager(...)` when you need to:
 * - Access `fs` for spy/mock setup (e.g. spyOn writeExclusiveSync)
 *
 * Drift safety: subclass `this.fs` access is type-checked by TypeScript;
 * ProcessManager field rename surfaces here at compile time.
 *
 * Same constructor signature as ProcessManager — drop-in replacement.
 */
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';

export class TestProcessManager extends ProcessManager {
  /** Get internal FileSystem — for spy/mock setup on writeExclusiveSync etc. */
  testGetFs(): FileSystem {
    return this.fs;
  }
}
