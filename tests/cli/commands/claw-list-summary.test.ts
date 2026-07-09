/**
 * @module tests/cli/commands/claw-list-summary
 * Phase 832 Step B: claw list --summary formatting
 */

import { describe, it, expect } from 'vitest';
import { formatClawSummary } from '../../../src/cli/commands/claw-list.js';
import type { ContractSubtaskStats } from '../../../src/core/contract/index.js';

function makeClaw(overrides: Partial<{
  name: string;
  status: 'running' | 'stopped';
  pid: number | undefined;
  lastActive: string;
  lastActiveIso: string | null;
  contract: string;
  outbox: number;
}> = {}): {
    name: string;
    status: 'running' | 'stopped';
    pid?: number;
    lastActiveIso: string | null;
    contract: string;
    outbox: number;
    lastActive: string;
    lastContract: string;
  } {
  return {
    name: 'analyst-claw',
    status: 'running',
    pid: 84321,
    lastActive: '2m',
    lastActiveIso: new Date(Date.now() - 2 * 60_000).toISOString(),
    contract: '-',
    outbox: 0,
    lastContract: 'daily-benchmark-july',
    ...overrides,
  };
}

function makeStats(overrides: Partial<ContractSubtaskStats> = {}): ContractSubtaskStats {
  return {
    title: 'daily-benchmark-july',
    total: 4,
    passed: 4,
    forceAccepted: 0,
    abandoned: 0,
    ...overrides,
  };
}

describe('formatClawSummary', () => {
  it('formats running claw with all-passed stats', () => {
    const output = formatClawSummary(makeClaw(), makeStats());
    expect(output).toContain('analyst-claw');
    expect(output).toContain('daemon: running · last active 2m ago · PID: 84321');
    expect(output).toContain('current: idle');
    expect(output).toContain('last completed: "daily-benchmark-july" · completed');
    expect(output).toContain('4 subtasks — all passed first attempt');
  });

  it('formats fresh claw with no history', () => {
    const output = formatClawSummary(
      makeClaw({ name: 'fresh-claw', status: 'stopped', pid: undefined, lastActive: '-', lastActiveIso: null }),
      null,
    );
    expect(output).toContain('fresh-claw');
    expect(output).toContain('daemon: stopped · last active never · PID: none');
    expect(output).toContain('current: no contract history — fresh claw');
    expect(output).not.toContain('last completed');
  });

  it('formats stopped claw with active contract', () => {
    const output = formatClawSummary(
      makeClaw({
        name: 'supply-risk',
        status: 'stopped',
        pid: undefined,
        lastActive: '23h',
        lastActiveIso: new Date(Date.now() - 23 * 60 * 60_000).toISOString(),
        contract: 'active',
        outbox: 6,
      }),
      makeStats({ title: '修复并扩展数据采集脚本', total: 0, passed: 0, forceAccepted: 0, abandoned: 0 }),
    );
    expect(output).toContain('supply-risk');
    expect(output).toContain('daemon: stopped · last active 23h ago · PID: none');
    expect(output).toContain('current: ⚠ has active contract "修复并扩展数据采集脚本" but daemon is stopped — needs restart');
    expect(output).toContain('⚠ 6 undelivered outbox messages');
  });

  it('formats force-accepted stats warning', () => {
    const output = formatClawSummary(
      makeClaw({ name: 'risky-claw', status: 'stopped', pid: undefined }),
      makeStats({ passed: 0, forceAccepted: 9, abandoned: 0 }),
    );
    expect(output).toContain('last completed: "daily-benchmark-july" · completed');
    expect(output).toContain('4 subtasks — ⚠ all force-accepted (retry limit reached)');
  });

  it('formats mixed quality stats', () => {
    const output = formatClawSummary(
      makeClaw(),
      makeStats({ passed: 3, forceAccepted: 1, abandoned: 0 }),
    );
    expect(output).toContain('4 subtasks — 3 passed, ⚠ 1 force-accepted (retry limit reached)');
  });

  it('formats abandoned stats', () => {
    const output = formatClawSummary(
      makeClaw(),
      makeStats({ passed: 1, forceAccepted: 1, abandoned: 2 }),
    );
    expect(output).toContain('4 subtasks — 1 passed, 1 force-accepted, 2 abandoned');
  });

  it('truncates long titles to 60 chars', () => {
    const longTitle = 'a'.repeat(100);
    const output = formatClawSummary(
      makeClaw(),
      makeStats({ title: longTitle }),
    );
    expect(output).toContain(`last completed: "${'a'.repeat(60)}" · completed`);
  });

  it('marks running claw as stalled when inactive for >=5m', () => {
    const output = formatClawSummary(
      makeClaw({ lastActive: '23h', lastActiveIso: new Date(Date.now() - 23 * 60 * 60_000).toISOString() }),
      makeStats(),
    );
    expect(output).toContain('daemon: running · last active 23h ago (⚠ stalled) · PID: 84321');
  });

  it('shows working on active contract when running and active', () => {
    const output = formatClawSummary(
      makeClaw({ contract: 'active' }),
      makeStats({ title: 'weekly-report-20260709', total: 0, passed: 0, forceAccepted: 0, abandoned: 0 }),
    );
    expect(output).toContain('current: working on "weekly-report-20260709"');
    expect(output).not.toContain('last completed');
  });
});
