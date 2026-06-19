import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { assertEvolutionStateShape } from '../../../src/core/evolution-system/invariants.js';
import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

// ============================================================================
// Helpers
// ============================================================================
function createMockAudit() {
  return {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
    __brand: 'AuditLog' as const,
  };
}

async function setupEvolutionSystem(overrides?: {
  stateFileContent?: string;
  lastProcessedAt?: number;
}) {
  const tmpBase = path.join(os.tmpdir(), `phase253-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'clawspace', 'dispatch-skills'), { recursive: true });

  if (overrides?.stateFileContent !== undefined) {
    await fs.writeFile(path.join(motionDir, '.evolution-system-state.json'), overrides.stateFileContent);
  }

  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const mockAudit = createMockAudit();
  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem: { schedule: vi.fn().mockResolvedValue('mock-task-id') } as any,
    contractManager: {} as any,
  });

  // 允许通过反射注入 lastProcessedAt（用于测试非法状态）
  if (overrides?.lastProcessedAt !== undefined) {
    (evolutionSystem as any).state = { version: 1, lastProcessedAt: overrides.lastProcessedAt };
  }

  return { motionDir, evolutionSystem, mockAudit };
}

async function cleanup(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

// ============================================================================
// Unit tests: assertEvolutionStateShape
// ============================================================================
describe('evolution-system state save invariant (phase 253 Step A + phase 280)', () => {
  let mockAudit: ReturnType<typeof createMockAudit>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockAudit = createMockAudit();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('state 根 check', () => {
    it('state=null → emit kind=state_not_object', () => {
      assertEvolutionStateShape(null, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=state_not_object`, `actual=object`,
      );
    });

    it('state=undefined → emit kind=state_not_object', () => {
      assertEvolutionStateShape(undefined, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=state_not_object`, `actual=undefined`,
      );
    });

    it('state=string → emit kind=state_not_object', () => {
      assertEvolutionStateShape('bad', mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=state_not_object`, `actual=string`,
      );
    });
  });

  describe('version', () => {
    it('version=1, lastProcessedAt=0 → 0 emit', () => {
      assertEvolutionStateShape({ version: 1, lastProcessedAt: 0 }, mockAudit as any);
      const calls = mockAudit.write.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED);
      expect(calls).toHaveLength(0);
    });

    it('version="1" 字符串 → emit kind=version_not_number', () => {
      assertEvolutionStateShape({ version: '1', lastProcessedAt: 0 }, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=version_not_number`, `actual=string`,
      );
    });

    it('version=2 → emit kind=version_mismatch', () => {
      assertEvolutionStateShape({ version: 2, lastProcessedAt: 0 }, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=version_mismatch`, `actual=2`, `expected=1`,
      );
    });

    it('version=undefined → emit kind=version_not_number', () => {
      assertEvolutionStateShape({ lastProcessedAt: 0 }, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=version_not_number`, `actual=undefined`,
      );
    });
  });

  describe('lastProcessedAt', () => {
    it('合法 0 → 0 emit', () => {
      assertEvolutionStateShape({ version: 1, lastProcessedAt: 0 }, mockAudit as any);
      const calls = mockAudit.write.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED);
      expect(calls).toHaveLength(0);
    });

    it('合法正数 → 0 emit', () => {
      assertEvolutionStateShape({ version: 1, lastProcessedAt: 1717000000000 }, mockAudit as any);
      const calls = mockAudit.write.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED);
      expect(calls).toHaveLength(0);
    });

    it('负数 → emit kind=lastProcessedAt_invalid', () => {
      assertEvolutionStateShape({ version: 1, lastProcessedAt: -1 }, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=lastProcessedAt_invalid`, `actual=-1`,
      );
    });

    it('NaN → emit kind=lastProcessedAt_invalid', () => {
      assertEvolutionStateShape({ version: 1, lastProcessedAt: NaN }, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=lastProcessedAt_invalid`, `actual=NaN`,
      );
    });

    it('Infinity → emit kind=lastProcessedAt_invalid', () => {
      assertEvolutionStateShape({ version: 1, lastProcessedAt: Infinity }, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=lastProcessedAt_invalid`, `actual=Infinity`,
      );
    });

    it('字符串 → emit kind=lastProcessedAt_invalid', () => {
      assertEvolutionStateShape({ version: 1, lastProcessedAt: '0' }, mockAudit as any);
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `kind=lastProcessedAt_invalid`, `actual=0`,
      );
    });
  });

  describe('_saveState 集成', () => {
    let fixtures: Awaited<ReturnType<typeof setupEvolutionSystem>>;

    afterEach(async () => {
      if (fixtures?.motionDir) {
        await cleanup(path.dirname(fixtures.motionDir));
      }
    });

    it('合法路径（构造 data 后调）→ 0 emit + 文件落盘', async () => {
      fixtures = await setupEvolutionSystem();
      const { motionDir, evolutionSystem, mockAudit } = fixtures;

      // 通过 _saveState 的公开触发路径：反射调用
      await (evolutionSystem as any)._saveState();

      const statePath = path.join(motionDir, '.evolution-system-state.json');
      const content = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(content);
      expect(state.version).toBe(1);
      expect(state.lastProcessedAt).toBe(0);

      const invariantCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED
      );
      expect(invariantCalls).toHaveLength(0);
    });

    it('非法 state（lastProcessedAt 负数）→ 文件仍落盘 + audit emit', async () => {
      fixtures = await setupEvolutionSystem({ lastProcessedAt: -1 });
      const { motionDir, evolutionSystem, mockAudit } = fixtures;

      await (evolutionSystem as any)._saveState();

      // 文件仍落盘
      const statePath = path.join(motionDir, '.evolution-system-state.json');
      const content = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(content);
      expect(state.lastProcessedAt).toBe(-1);

      // audit emit
      const invariantCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED
      );
      expect(invariantCalls.length).toBeGreaterThanOrEqual(1);
      expect(invariantCalls.some((c: any[]) =>
        c.some((arg: any) => String(arg).includes('lastProcessedAt_invalid'))
      )).toBe(true);
    });
  });
});
