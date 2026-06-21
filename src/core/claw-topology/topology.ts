import * as path from 'path';
import { CLAWS_DIR, enumerateClaws } from '../../foundation/claw-paths.js';
import type { ClawId } from '../../foundation/identity/index.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { ClawTopology, ClawTopologyDeps } from './types.js';
import { ClawIdResolveError, CrossClawReadError } from './types.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from './audit-events.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';

export function createClawTopology(deps: ClawTopologyDeps): ClawTopology {
  const { fs, chestnutRoot, audit, motionDir } = deps;
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);

  return {
    enumerate() {
      const clawIds = enumerateClaws(fs, clawsDir).map(makeClawId);
      return [MOTION_CLAW_ID, ...clawIds];
    },
    resolve(clawId) {
      if (clawId === MOTION_CLAW_ID) {
        return { kind: 'local', clawDir: path.join(chestnutRoot, motionDir) };
      }
      const clawDir = path.join(clawsDir, clawId);
      if (!fs.existsSync(clawDir)) {
        audit?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED, `clawId=${clawId}`, 'reason=not_found');
        throw new ClawIdResolveError(clawId, 'not_found');
      }
      return { kind: 'local', clawDir };
    },
    async read(clawId, relPath) {
      const location = this.resolve(clawId);
      if (location.kind !== 'local') {
        throw new CrossClawReadError(clawId, relPath, 'remote location not supported in single-host mode');
      }
      const absPath = path.join(location.clawDir, relPath);
      try {
        return await fs.read(absPath);
      } catch (err) {
        audit?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_READ_FAILED, `clawId=${clawId}`, `relPath=${relPath}`, `error=${String(err)}`);
        throw new CrossClawReadError(clawId, relPath, err);
      }
    },
    async readJSON<T>(clawId: ClawId, relPath: string): Promise<T> {
      const content = await this.read(clawId, relPath);
      return JSON.parse(content) as T;
    },
  };
}
