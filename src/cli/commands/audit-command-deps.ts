import type { RootConfigReader } from '../../assembly/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

/** CLIProcess-internal dependencies shared by the read-only Audit command family. */
export interface AuditCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'>;
}
