import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from '../../../src/core/claw-topology/audit-events.js';
import { ClawIdResolveError, CrossClawReadError } from '../../../src/core/claw-topology/types.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';

describe('createClawTopology', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let auditWrites: [string, ...(string | number)[]][];

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    auditWrites = [];
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeAudit() {
    return {
      write: vi.fn((...args: [string, ...(string | number)[]]) => {
        auditWrites.push(args);
      }),
    } as unknown as import('../../../src/foundation/audit/index.js').AuditLog;
  }

  it('enumerate 含 motion + claws 子目录', async () => {
    await fs.ensureDir('claws/claw1');
    await fs.ensureDir('claws/claw2');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, audit: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const ids = topology.enumerate();
    expect(ids).toContain(makeClawId('motion'));
    expect(ids).toContain('claw1');
    expect(ids).toContain('claw2');
    expect(ids.length).toBe(3);
  });

  it('resolve motion → chestnutRoot/motion', () => {
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, audit: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const loc = topology.resolve(makeClawId('motion'));
    expect(loc.kind).toBe('local');
    expect(loc.clawDir).toBe(path.join(tempDir, 'motion'));
  });

  it('resolve claw_id → chestnutRoot/claws/<id>', async () => {
    await fs.ensureDir('claws/alpha');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, audit: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const loc = topology.resolve('alpha');
    expect(loc.kind).toBe('local');
    expect(loc.clawDir).toBe(path.join(tempDir, 'claws', 'alpha'));
  });

  it('resolve 不存在 claw → throw ClawIdResolveError + audit', () => {
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, audit: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    expect(() => topology.resolve('nonexistent')).toThrow(ClawIdResolveError);
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0][0]).toBe(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED);
  });

  it('read + readJSON 成功路径', async () => {
    await fs.ensureDir('claws/beta');
    await fs.writeAtomic('claws/beta/data.json', '{"hello":"world"}');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, audit: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const text = await topology.read('beta', 'data.json');
    expect(text).toBe('{"hello":"world"}');
    const obj = await topology.readJSON<{ hello: string }>('beta', 'data.json');
    expect(obj.hello).toBe('world');
  });

  it('read 不存在文件 → throw CrossClawReadError + audit', async () => {
    await fs.ensureDir('claws/gamma');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, audit: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    await expect(topology.read('gamma', 'missing.txt')).rejects.toThrow(CrossClawReadError);
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0][0]).toBe(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_READ_FAILED);
  });
});
