/**
 * retro-scheduler unit tests (phase 990 / r121 F fork)
 *
 * Tests scheduleRetro paths via mocked skill-system + prompt builder + pending writer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scheduleRetro } from '../../../src/core/evolution-system/retro-scheduler.js';
import type { RetroConfig } from '../../../src/core/evolution-system/retro-scheduler.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_TIMEOUT_MS } from '../../../src/core/subagent/constants.js';

const { mockSkillLoadAll, mockSkillFormat, mockSchedule } = vi.hoisted(() => ({
  mockSkillLoadAll: vi.fn().mockResolvedValue(undefined),
  mockSkillFormat: vi.fn().mockReturnValue('No skills loaded'),
  mockSchedule: vi.fn().mockResolvedValue('mock-task-id'),
}));

vi.mock('../../../src/foundation/skill-system/registry.js', () => ({
  SkillSystem: vi.fn().mockImplementation(() => ({
    loadAll: mockSkillLoadAll,
    formatForContext: mockSkillFormat,
  })),
}));

function makeConfig(overrides: Partial<RetroConfig> = {}): RetroConfig {
  return {
    targetClaw: 'claw-test',
    contractId: 'c-1',
    contractYaml: 'yaml: true',
    motionFs: {} as unknown as FileSystem,
    motionAudit: { write: vi.fn() } as unknown as AuditLog,
    motionBaseDir: '/tmp/motion',
    baseMessages: [{ role: 'user', content: 'hi' }],
    audit: { write: vi.fn() } as unknown as AuditLog,
    taskSystem: { schedule: mockSchedule } as unknown as RetroConfig['taskSystem'],
    ...overrides,
  };
}

describe('scheduleRetro (phase 990)', () => {
  beforeEach(() => {
    mockSkillLoadAll.mockClear();
    mockSkillFormat.mockClear().mockReturnValue('No skills loaded');
    mockSchedule.mockClear().mockResolvedValue('mock-task-id');
  });

  it('schedules retro with default timeout when skills empty', async () => {
    const config = makeConfig();
    await scheduleRetro(config);
    expect(mockSkillLoadAll).toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledWith(
      'subagent',
      expect.objectContaining({
        kind: 'subagent',
        intent: expect.stringContaining('yaml: true'),
        timeoutMs: SUBAGENT_TIMEOUT_MS * 2,  // phase 1159: retro 任务 = 2 × subagent default timeout
        parentClawId: 'motion',
        originClawId: 'motion',
      }),
    );
  });

  it('includes skills summary when skills loaded', async () => {
    mockSkillFormat.mockReturnValue('skillA, skillB');
    const config = makeConfig();
    await scheduleRetro(config);
    expect(mockSchedule).toHaveBeenCalledWith(
      'subagent',
      expect.objectContaining({
        intent: expect.stringContaining('skillA, skillB'),
      }),
    );
  });

  it('logs skill failure and continues when loadAll throws', async () => {
    mockSkillLoadAll.mockRejectedValue(new Error('disk full'));
    const config = makeConfig();
    await scheduleRetro(config);
    expect(config.audit.write).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('disk full'),
    );
    expect(mockSchedule).toHaveBeenCalled();
  });

  it('uses custom retroSubagentTimeoutMs when provided', async () => {
    const config = makeConfig({ retroSubagentTimeoutMs: 120000 });
    await scheduleRetro(config);
    expect(mockSchedule).toHaveBeenCalledWith(
      'subagent',
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });
});
