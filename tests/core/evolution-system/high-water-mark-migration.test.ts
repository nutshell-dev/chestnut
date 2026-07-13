/**
 * phase 280 — evolution-system high-water-mark migration tests
 *
 * 覆盖 legacy schema（processedContractIds + lastProcessedAt ISO string）→ 高水位线 silent reset + audit emit。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function createMockAudit() {
  return {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
    __brand: 'AuditLog' as const,
  };
}

async function setupEvolutionSystem(stateFileContent?: string) {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase280-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'clawspace', 'dispatch-skills'), { recursive: true });

  if (stateFileContent !== undefined) {
    await fs.writeFile(path.join(motionDir, '.evolution-system-state.json'), stateFileContent);
  }

  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const mockAudit = createMockAudit();
  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem: { schedule: vi.fn().mockResolvedValue('mock-task-id') } as any,
    contractManager: {} as any,
  });

  return { motionDir, evolutionSystem, mockAudit };
}

async function cleanup(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

describe('evolution-system legacy schema migration (phase 280)', () => {
  let fixtures: Awaited<ReturnType<typeof setupEvolutionSystem>>;

  afterEach(async () => {
    if (fixtures?.motionDir) {
      await cleanup(path.dirname(fixtures.motionDir));
    }
  });

  it('legacy state 含 processedContractIds → migrate to lastProcessedAt=0 + audit emit', async () => {
    fixtures = await setupEvolutionSystem(JSON.stringify({
      version: 1,
      processedContractIds: ['c1', 'c2'],
      lastProcessedAt: '2026-06-10T12:00:00Z',
    }));
    const { evolutionSystem, mockAudit } = fixtures;

    await (evolutionSystem as any)._ensureStateLoaded();

    const state = (evolutionSystem as any).state;
    expect(state.lastProcessedAt).toBe(0);
    expect(state.version).toBe(1);

    const migrationCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_SCHEMA_MIGRATED_RESET
    );
    expect(migrationCalls).toHaveLength(1);
    expect(migrationCalls[0]).toEqual(expect.arrayContaining([
      expect.stringMatching(/^legacy_field=processedContractIds$/),
      expect.stringMatching(/^legacy_count=2$/),
    ]));
  });

  it('新 schema → 0 migration 触发 + 正常加载', async () => {
    fixtures = await setupEvolutionSystem(JSON.stringify({
      version: 1,
      lastProcessedAt: 1717000000000,
    }));
    const { evolutionSystem, mockAudit } = fixtures;

    await (evolutionSystem as any)._ensureStateLoaded();

    const state = (evolutionSystem as any).state;
    expect(state.lastProcessedAt).toBe(1717000000000);
    expect(state.version).toBe(1);

    const migrationCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_SCHEMA_MIGRATED_RESET
    );
    expect(migrationCalls).toHaveLength(0);
  });

  it('文件不存在 → 默认 lastProcessedAt=0 + 0 audit', async () => {
    fixtures = await setupEvolutionSystem();
    const { evolutionSystem, mockAudit } = fixtures;

    await (evolutionSystem as any)._ensureStateLoaded();

    const state = (evolutionSystem as any).state;
    expect(state.lastProcessedAt).toBe(0);
    expect(mockAudit.write).not.toHaveBeenCalled();
  });

  it('损坏 JSON → backup + emit STATE_LOAD_FAILED', async () => {
    fixtures = await setupEvolutionSystem('not-json');
    const { motionDir, evolutionSystem, mockAudit } = fixtures;

    await (evolutionSystem as any)._ensureStateLoaded();

    const state = (evolutionSystem as any).state;
    expect(state.lastProcessedAt).toBe(0);

    const loadFailedCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED
    );
    expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);

    // corrupt backup 文件应存在
    const files = await fs.readdir(motionDir);
    expect(files.some(f => f.startsWith('.evolution-system-state.json.corrupt-'))).toBe(true);
  });
});
