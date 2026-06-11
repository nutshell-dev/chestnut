/**
 * chat-viewport-claw-manager refreshAllClawStatus silent watcher narrow (phase 979 step B)
 *
 * 验证 catch (err) narrow ENOENT + non-ENOENT audit emit REFRESH_CLAWS_FAILED
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClawManager } from '../../../src/cli/commands/chat-viewport-claw-manager.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../../src/cli/commands/viewport-audit-events.js';
import { makeAudit } from '../../helpers/audit.js';
import type { ClawTopology } from '../../../src/core/claw-topology/index.js';

function makeMockTopology(clawsDir: string): ClawTopology {
  return {
    enumerate: vi.fn().mockReturnValue([]),
    resolve: vi.fn((clawId: string) => ({ kind: 'local', clawDir: `${clawsDir}/${clawId}` })),
    read: vi.fn(),
    readJSON: vi.fn(),
  } as unknown as ClawTopology;
}

describe('phase 979: refreshAllClawStatus silent watcher narrow', () => {
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    audit = makeAudit();
  });

  it('ENOENT silent OK — clawsDir 首次启动 → 0 REFRESH_CLAWS_FAILED audit emit', async () => {
    const fsThrowEnoent = {
      listSync: vi.fn(() => {
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }),
    } as any;

    const manager = createClawManager({
      fs: fsThrowEnoent,
      pm: { readPid: async () => null },
      audit: audit.audit,
      isMotion: true,
      clawsDir: '/test/claws',
      clawTopology: makeMockTopology('/test/claws'),
      clawTrackMap: new Map(),
      updateClawPanel: vi.fn(),
      requestRender: vi.fn(),
    });

    await manager.refreshAllClawStatus();

    // 反向：REFRESH_CLAWS_FAILED 必 0 emit (ENOENT silent)
    expect(audit.events.filter(e => e[0] === VIEWPORT_AUDIT_EVENTS.REFRESH_CLAWS_FAILED).length).toBe(0);
  });

  it('non-ENOENT (EACCES) → REFRESH_CLAWS_FAILED audit emit with code+error fields', async () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const topologyThrowEacces: ClawTopology = {
      enumerate: vi.fn(() => { throw err; }),
      resolve: vi.fn((clawId: string) => ({ kind: 'local', clawDir: `/test/claws/${clawId}` })),
      read: vi.fn(),
      readJSON: vi.fn(),
    } as unknown as ClawTopology;

    const manager = createClawManager({
      fs: {} as any,
      pm: { readPid: async () => null },
      audit: audit.audit,
      isMotion: true,
      clawsDir: '/test/claws',
      clawTopology: topologyThrowEacces,
      clawTrackMap: new Map(),
      updateClawPanel: vi.fn(),
      requestRender: vi.fn(),
    });

    await manager.refreshAllClawStatus();

    // 实测 REFRESH_CLAWS_FAILED emit + code/error fields
    const failedRow = audit.events.find(e => e[0] === VIEWPORT_AUDIT_EVENTS.REFRESH_CLAWS_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('code=EACCES');
    expect(failedRow!.some(f => typeof f === 'string' && f.startsWith('error='))).toBe(true);
  });
});
