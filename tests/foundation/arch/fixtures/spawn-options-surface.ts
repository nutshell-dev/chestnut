import type { SpawnOptions as OwnerOptions } from '../../../../src/foundation/process-manager/types.js';
import type { SpawnOptions as PublicOptions } from '../../../../src/foundation/process-manager/index.js';

// @ts-expect-error SpawnOptions must not be forwarded by manager.ts.
import type { SpawnOptions as ManagerOptions } from '../../../../src/foundation/process-manager/manager.js';

export const ownerOptions = {
  command: 'node',
  args: ['daemon-entry.js'],
  cwd: '/workspace',
  logFile: '/workspace/daemon.log',
  env: { GENERATION_ID: 'generation-1' },
} satisfies OwnerOptions;

export const publicOptions: PublicOptions = ownerOptions;
export type ForbiddenManagerOptions = ManagerOptions;
