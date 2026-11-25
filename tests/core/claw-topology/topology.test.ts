import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createClawTopology, enumerateOrdinaryClaws } from '../../../src/core/claw-topology/topology.js';
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
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const ids = topology.enumerate();
    expect(ids).toContain(makeClawId('motion'));
    expect(ids).toContain('claw1');
    expect(ids).toContain('claw2');
    expect(ids.length).toBe(3);
  });

  it('enumerateOrdinaryClaws 保留顺序并分类 reserved/invalid', () => {
    vi.spyOn(fs, 'listSync').mockReturnValue([
      { name: 'zeta', isDirectory: true },
      { name: 'motion', isDirectory: true },
      { name: '.trash', isDirectory: true },
      { name: 'alpha', isDirectory: true },
      { name: 'a..b', isDirectory: true },
    ] as any);

    expect(enumerateOrdinaryClaws(fs, 'claws')).toEqual({
      valid: [makeClawId('zeta'), makeClawId('alpha')],
      invalid: [
        { dir: 'motion', reason: 'reserved_motion' },
        { dir: '.trash', reason: 'invalid_claw_id_format' },
        { dir: 'a..b', reason: 'invalid_claw_id_format' },
      ],
    });
  });

  it('enumerateOrdinaryClaws 原样透传 FS 错误', () => {
    const failure = Object.assign(new Error('claws EACCES'), { code: 'EACCES' });
    vi.spyOn(fs, 'listSync').mockImplementation(() => { throw failure; });
    let thrown: unknown;
    try {
      enumerateOrdinaryClaws(fs, 'claws');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });

  it('resolve motion → chestnutRoot/motion', () => {
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const loc = topology.resolve(makeClawId('motion'));
    expect(loc.kind).toBe('local');
    expect(loc.clawDir).toBe(path.join(tempDir, 'motion'));
  });

  it('resolve claw_id → chestnutRoot/claws/<id>', async () => {
    await fs.ensureDir('claws/alpha');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const loc = topology.resolve('alpha');
    expect(loc.kind).toBe('local');
    expect(loc.clawDir).toBe(path.join(tempDir, 'claws', 'alpha'));
  });

  it('resolve 不存在 claw → throw ClawIdResolveError + audit', () => {
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    expect(() => topology.resolve('nonexistent')).toThrow(ClawIdResolveError);
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0][0]).toBe(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED);
  });

  it('read + readJSON 成功路径（限定在 clawspace）', async () => {
    await fs.ensureDir('claws/beta/clawspace');
    await fs.writeAtomic('claws/beta/clawspace/data.json', '{"hello":"world"}');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const text = await topology.read('beta', 'data.json');
    expect(text).toBe('{"hello":"world"}');
    const raw = await topology.readJSON('beta', 'data.json');
    // phase 1811：readJSON 返回 unknown，caller 边界显式 decode（示例：最小 guard）
    expect(typeof raw).toBe('object');
    const obj = raw as { hello?: unknown };
    expect(obj.hello).toBe('world');
  });

  it('read 不存在文件 → throw CrossClawReadError + audit', async () => {
    await fs.ensureDir('claws/gamma/clawspace');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    await expect(topology.read('gamma', 'missing.txt')).rejects.toThrow(CrossClawReadError);
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0][0]).toBe(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_READ_FAILED);
  });

  it('read 合法子目录 relPath → 成功', async () => {
    await fs.ensureDir('claws/delta/clawspace/notes');
    await fs.writeAtomic('claws/delta/clawspace/notes/2026.md', '# notes');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const text = await topology.read('delta', 'notes/2026.md');
    expect(text).toBe('# notes');
  });

  it('read 穿越 clawspace 的 relPath → throw CrossClawReadError', async () => {
    await fs.ensureDir('claws/delta/clawspace');
    await fs.writeAtomic('claws/delta/clawspace/data.json', '{}');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    await expect(topology.read('delta', '../data.json')).rejects.toThrow(CrossClawReadError);
  });

  it('read ".." 或 "." → throw CrossClawReadError（path traversal not allowed）', async () => {
    await fs.ensureDir('claws/epsilon/clawspace');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    await expect(topology.read('epsilon', '..')).rejects.toThrow(CrossClawReadError);
    await expect(topology.read('epsilon', '.')).rejects.toThrow(CrossClawReadError);
  });

  it('enumerate skips invalid claw directory names', async () => {
    await fs.ensureDir('claws/valid-claw');
    await fs.ensureDir('claws/.trash');
    await fs.ensureDir('claws/a..b');
    const audit = makeAudit();
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: audit, motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const ids = topology.enumerate();
    expect(ids).toContain(makeClawId('motion'));
    expect(ids).toContain('valid-claw');
    expect(ids).not.toContain('.trash');
    expect(ids).not.toContain('a..b');
    expect(ids.length).toBe(2);
    expect(auditWrites.some(e => e[0] === CLAW_TOPOLOGY_AUDIT_EVENTS.INVALID_CLAW_DIR)).toBe(true);
  });

  // phase 1864 Step F（CT-D9）：invalid/incomplete 事实进 snapshot（不静默丢弃）
  it('enumerateSnapshot 携带 invalid 目录（不静默丢弃）', async () => {
    await fs.ensureDir('claws/valid-claw');
    await fs.ensureDir('claws/.trash');
    const audit = makeAudit();
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: audit, motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const snapshot = topology.enumerateSnapshot();
    expect(snapshot.valid).toEqual([makeClawId('motion'), makeClawId('valid-claw')]);
    expect(snapshot.invalid).toEqual([{ dir: '.trash', reason: 'invalid_claw_id_format' }]);
    expect(auditWrites.filter(e => e[0] === CLAW_TOPOLOGY_AUDIT_EVENTS.INVALID_CLAW_DIR)).toHaveLength(1);
  });

  it('enumerateSnapshot 保留 claws/motion 与无效目录证据且不修改工作文件', async () => {
    await fs.ensureDir('claws/motion/clawspace/work');
    await fs.writeAtomic('claws/motion/clawspace/work/sentinel.txt', 'keep me');
    await fs.ensureDir('claws/claw1');
    await fs.ensureDir('claws/.trash');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: makeAudit(), motionClawId: makeClawId('motion'), motionDir: 'motion' });
    const snapshot = topology.enumerateSnapshot();
    expect(snapshot.valid).toEqual([makeClawId('motion'), makeClawId('claw1')]);
    expect(snapshot.invalid).toHaveLength(2);
    expect(snapshot.invalid).toEqual(expect.arrayContaining([
      { dir: 'motion', reason: 'reserved_motion' },
      { dir: '.trash', reason: 'invalid_claw_id_format' },
    ]));
    expect(topology.enumerate()).toEqual([...snapshot.valid]);
    const invalidDirAudits = auditWrites.filter(e => e[0] === CLAW_TOPOLOGY_AUDIT_EVENTS.INVALID_CLAW_DIR);
    expect(invalidDirAudits).toHaveLength(2);
    expect(invalidDirAudits).toEqual(expect.arrayContaining([
      [CLAW_TOPOLOGY_AUDIT_EVENTS.INVALID_CLAW_DIR, 'dir=.trash', 'reason=invalid_claw_id_format'],
    ]));
    expect(invalidDirAudits.flat().join(' ')).not.toContain('dir=motion');
    expect(await fs.read('claws/motion/clawspace/work/sentinel.txt')).toBe('keep me');
  });

  // phase 1864 Step I（CT-D12）：sink 省略（无观察装配）/ 注入 / throw 三态语义
  it('sink 省略 → 拓扑查询静默可用（观察缺失不改变主结果）', async () => {
    await fs.ensureDir('claws/valid-claw');
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, motionClawId: makeClawId('motion'), motionDir: 'motion' });
    expect(topology.enumerate()).toEqual([makeClawId('motion'), makeClawId('valid-claw')]);
    expect(topology.resolve(makeClawId('valid-claw')).clawDir).toBe(path.join(tempDir, 'claws', 'valid-claw'));
  });

  it('sink.write throw 传播（Topology 不吞观察失败）', async () => {
    await fs.ensureDir('claws/.trash');
    const throwingSink = { write: () => { throw new Error('sink down'); } };
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: throwingSink, motionClawId: makeClawId('motion'), motionDir: 'motion' });
    expect(() => topology.enumerateSnapshot()).toThrow('sink down');
  });

  it('resolve throws for non-directory claw entry', async () => {
    await fs.ensureDir('claws');
    await fs.writeAtomic('claws/claw-file', 'not a directory');
    const audit = makeAudit();
    const topology = createClawTopology({ fs, chestnutRoot: tempDir, sink: audit, motionClawId: makeClawId('motion'), motionDir: 'motion' });
    expect(() => topology.resolve('claw-file')).toThrow(ClawIdResolveError);
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0][0]).toBe(CLAW_TOPOLOGY_AUDIT_EVENTS.CLAW_DIR_NOT_DIRECTORY);
  });
});
