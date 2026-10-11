/**
 * Phase 1934 Step G（F-08）：Evolution legacy 读取失败留证。
 *
 * 覆盖：
 * ① absent：无失败事件、无 observed 事件，init 正常完成
 * ② present：observed 事件，无 read_failed 事件；不读取 legacy 内容、不修改字节
 * ③ EIO / EACCES：evolution_legacy_state_read_failed 事件含 path/reason；
 *    return 仅离开观察函数——boot recovery（recoverRetrospectives）仍执行
 * ④ audit 自身故障：stderr 降级保留原错，init 不崩、不假装已留证
 * 反向：legacy 字节不被修改；submitted 语义不受影响
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { createTestTaskSystem } from '../../helpers/task-system.js';

const { mockSkillVersions } = vi.hoisted(() => ({
  mockSkillVersions: { formatPublishedForContext: vi.fn().mockReturnValue('No skills loaded') },
}));

const LEGACY_STATE_FILE_PATH = '.evolution-system-state.json';

/** 真实 FileSystem 契约 seam：委托 NodeFileSystem，仅对目标 path 的 exists 注入故障。 */
function fsWithExistsFailure(base: NodeFileSystem, failWith: () => Error): FileSystem {
  const handler: ProxyHandler<NodeFileSystem> = {
    get(target, prop, receiver) {
      if (prop === 'exists') {
        return async (p: string) => {
          if (p === LEGACY_STATE_FILE_PATH) throw failWith();
          return target.exists(p);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  };
  return new Proxy(base, handler) as unknown as FileSystem;
}

async function setup(motionFsOverride?: FileSystem) {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase1934-legacy-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const contractId = makeContractId('c-' + randomUUID());
  await fs.mkdir(motionDir, { recursive: true });
  await fs.mkdir(path.join(clawsBaseDir, 'claw-a'), { recursive: true });

  const nodeFs = new NodeFileSystem({ baseDir: motionDir });
  const motionFs = motionFsOverride ?? nodeFs;
  const mockAudit = {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  };

  const taskSystem = createTestTaskSystem(motionDir, nodeFs, mockAudit as any);
  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem,
    contractManager: {} as any,
    skillVersions: mockSkillVersions as any,
  });

  const ctx: MotionReviewContext = {
    motionFs,
    motionBaseDir: motionDir,
    motionAudit: { write: vi.fn() } as any,
    clawsBaseDir,
    clawFsFactory: (clawDir: string) => new NodeFileSystem({ baseDir: clawDir }),
    clawContractManagerFactory: vi.fn().mockReturnValue({
      readContractYamlRaw: vi.fn().mockResolvedValue(`contract_id: ${contractId}\nintent: test`),
      getProgress: vi.fn().mockResolvedValue({ completed_at: new Date().toISOString() }),
    }),
  };

  return { tmpBase, motionDir, nodeFs, motionFs, mockAudit, evolutionSystem, ctx };
}

function eventsOf(mockAudit: { write: ReturnType<typeof vi.fn> }, type: string) {
  return mockAudit.write.mock.calls.filter(c => c[0] === type);
}

describe('EvolutionSystem legacy state read failure（phase 1934 Step G）', () => {
  let tmpBase: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (tmpBase) {
      await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      tmpBase = undefined;
    }
  });

  it('① absent：无 read_failed / observed 事件，boot recovery 照常执行', async () => {
    const s = await setup();
    tmpBase = s.tmpBase;

    await s.evolutionSystem.init(s.ctx);

    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_READ_FAILED)).toHaveLength(0);
    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_FILE_OBSERVED)).toHaveLength(0);
    // init 后续 recoverRetrospectives 仍执行（boot reconcile 事件为证）
    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE)).toHaveLength(1);
  });

  it('② present：observed 事件，无 read_failed；legacy 字节不被读取/修改', async () => {
    const s = await setup();
    tmpBase = s.tmpBase;
    const legacyContent = '{"schema_version":0,"legacy":true}';
    await s.nodeFs.writeAtomic(LEGACY_STATE_FILE_PATH, legacyContent);

    await s.evolutionSystem.init(s.ctx);

    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_FILE_OBSERVED)).toHaveLength(1);
    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_READ_FAILED)).toHaveLength(0);
    // 不修改 legacy 字节
    expect(await s.nodeFs.read(LEGACY_STATE_FILE_PATH)).toBe(legacyContent);
    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE)).toHaveLength(1);
  });

  it.each(['EIO', 'EACCES'])('③ %s：read_failed 事件含 path/reason，boot recovery 仍执行', async (code) => {
    const ioErr = Object.assign(new Error(`${code}: simulated`), { code });
    const s = await setup(undefined);
    tmpBase = s.tmpBase;
    const failingFs = fsWithExistsFailure(s.nodeFs, () => ioErr);
    const evolutionSystem = new EvolutionSystem({
      fs: failingFs,
      audit: s.mockAudit as any,
      taskSystem: createTestTaskSystem(s.motionDir, s.nodeFs, s.mockAudit as any),
      contractManager: {} as any,
      skillVersions: mockSkillVersions as any,
    });
    const ctx: MotionReviewContext = { ...s.ctx, motionFs: failingFs };

    await evolutionSystem.init(ctx);

    const failed = eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_READ_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContainEqual(`path=${LEGACY_STATE_FILE_PATH}`);
    expect(failed[0].some(c => String(c).startsWith('reason=') && String(c).includes(code))).toBe(true);
    // 无 observed（未知 ≠ present），init 后续 recovery 仍执行
    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_FILE_OBSERVED)).toHaveLength(0);
    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE)).toHaveLength(1);
  });

  it('④ audit 自身故障：stderr 降级保留原错，init 不崩、不假装留证', async () => {
    const ioErr = Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
    const s = await setup(undefined);
    tmpBase = s.tmpBase;
    const failingFs = fsWithExistsFailure(s.nodeFs, () => ioErr);
    const auditErr = new Error('audit sink down');
    // 仅 legacy read_failed 事件的 audit 故障；其余事件不受影响，避免混淆故障归属。
    s.mockAudit.write.mockImplementation((type: string, ...cols: unknown[]) => {
      if (type === RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_READ_FAILED) throw auditErr;
      return undefined;
    });
    const evolutionSystem = new EvolutionSystem({
      fs: failingFs,
      audit: s.mockAudit as any,
      taskSystem: createTestTaskSystem(s.motionDir, s.nodeFs, s.mockAudit as any),
      contractManager: {} as any,
      skillVersions: mockSkillVersions as any,
    });
    const ctx: MotionReviewContext = { ...s.ctx, motionFs: failingFs };
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // init 不崩：audit 故障不阻断 boot recovery；留证降级到 stderr。
    await evolutionSystem.init(ctx);

    // stderr 出口同时保留原 I/O 错与 audit 异常
    const written = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(written).toContain('legacy state read failed');
    expect(written).toContain('EIO');
    expect(written).toContain('audit sink down');
    // boot recovery 仍执行
    expect(eventsOf(s.mockAudit, RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE)).toHaveLength(1);
  });
});
