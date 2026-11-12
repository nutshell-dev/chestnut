/** Phase 2135 Step C: structured long-blocking exec policy and audit contract. */
import { describe, expect, it } from 'vitest';
import {
  EXEC_LONG_BLOCKING_REJECTED,
  EXEC_TURN_SYNC_LIMIT_MS,
  evaluateLongBlockingExec,
} from '../../../src/foundation/command-tool/blocking-policy.js';
import { COMMAND_TOOL_AUDIT_EVENTS } from '../../../src/foundation/command-tool/audit-events.js';
import { createExecTool } from '../../../src/foundation/command-tool/exec.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { EMPTY_OUTPUT_COMMAND, IS_WINDOWS } from './platform-commands.js';

const LONG_SYNC_TIMEOUT_MS = EXEC_TURN_SYNC_LIMIT_MS + 1;

describe('phase 2135 long-blocking exec structural classification', () => {
  it.each([
    { command: 'sleep 540', ruleId: 'exec_long_sleep' },
    { command: 'sleep "540"', ruleId: 'exec_long_sleep' },
    { command: "sleep '9m' && echo done", ruleId: 'exec_long_sleep' },
    { command: 'command /bin/sleep 31', ruleId: 'exec_long_sleep' },
    { command: 'while ! chestnut task status "$TASK_ID"; do sleep 5; done', ruleId: 'exec_fixed_interval_poll' },
    { command: 'until test -f ready; do sleep "0.5"; done', ruleId: 'exec_fixed_interval_poll' },
    { command: "watch -n 5 'chestnut status'", ruleId: 'exec_watch_poll' },
  ])('classifies $command as $ruleId beyond the sync budget', ({ command, ruleId }) => {
    expect(evaluateLongBlockingExec(command, LONG_SYNC_TIMEOUT_MS)).toMatchObject({
      ruleId,
      commandSummary: command,
      timeoutMs: LONG_SYNC_TIMEOUT_MS,
    });
  });

  it.each([
    'sleep 1',
    'sleep "0.05"',
    'sleep 30',
    'echo "sleep 540"',
    'echo sleep 540',
    "printf '%s' 'while true; do sleep 60; done'",
    'echo "watch -n 5"',
    'node scripts/long-build.js',
    'while true; do sleep "$DYNAMIC_INTERVAL"; done',
    'while test -f ready; do :; done; sleep 5',
    'until sleep 5; do echo attempt; done',
    'while true; do sleep 5; break; done',
    'watch --help',
    'watch --version',
    'watch -n 5',
    'cat <<EOF\nsleep 540\nEOF',
    'echo "unterminated; sleep 540',
    'sleep 540 &',
    'sleep "$DYNAMIC_DURATION"',
  ])('does not reject a legal or non-matching command: %s', command => {
    expect(evaluateLongBlockingExec(command, LONG_SYNC_TIMEOUT_MS)).toBeNull();
  });

  it('allows bounded execution and auto-migrating calls without an explicit sync timeout', () => {
    expect(evaluateLongBlockingExec('sleep 540', EXEC_TURN_SYNC_LIMIT_MS)).toBeNull();
    expect(evaluateLongBlockingExec('sleep 540', 1000)).toBeNull();
    expect(evaluateLongBlockingExec('sleep 540', undefined)).toBeNull();
    expect(evaluateLongBlockingExec('while true; do sleep 5; done', EXEC_TURN_SYNC_LIMIT_MS)).toBeNull();
    expect(evaluateLongBlockingExec('watch -n 5 chestnut status', EXEC_TURN_SYNC_LIMIT_MS)).toBeNull();
  });

  it('does not confuse a quoted sentence containing shell syntax with a command', () => {
    const command = 'echo "sleep 540; while true; do sleep 5; done; watch -n 1 status"';
    expect(evaluateLongBlockingExec(command, 600_000)).toBeNull();
  });
});

describe('phase 2135 typed rejection and audit', () => {
  it('returns the rule, original command summary and async alternative without spawning', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ auditWriter: audit, workspaceDir: process.cwd() });
    const command = 'sleep 540';

    const result = await createExecTool().execute({ command, timeoutMs: 600_000 }, ctx);

    expect(result).toMatchObject({
      success: false,
      error: EXEC_LONG_BLOCKING_REJECTED,
      metadata: {
        ruleId: 'exec_long_sleep',
        disposition: 'rejected',
        commandSummary: command,
        asyncCapability: 'async_exec_task_result',
      },
    });
    expect(result.content).toContain('[rule_id]: exec_long_sleep');
    expect(result.content).toContain('[command]: sleep 540');
    expect(result.content).toContain('omit timeoutMs');
    expect(result.content).toContain('task_result');
    expect(result.content).not.toContain('submit_subtask');
    expect(audit.write).toHaveBeenCalledWith(
      COMMAND_TOOL_AUDIT_EVENTS.EXEC_LONG_BLOCKING_REJECTED,
      'clawId=test-claw',
      'rule_id=exec_long_sleep',
      'disposition=rejected',
      'command_summary=sleep 540',
      'timeout_ms=600000',
      'observed_sleep_ms=540000',
      'async_capability=async_exec_task_result',
    );
  });

  it('preserves the existing abort path instead of replacing it with a policy rejection', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createExecTool().execute(
      { command: 'sleep 540', timeoutMs: 600_000 },
      makeExecContext({ workspaceDir: process.cwd(), signal: controller.signal }),
    );

    expect(result.success).toBe(false);
    expect(result.error).not.toBe(EXEC_LONG_BLOCKING_REJECTED);
    expect(result.content).toMatch(/abort/i);
  });

  it.skipIf(IS_WINDOWS)('still executes a legal short sleep with a larger timeout', async () => {
    const result = await createExecTool().execute(
      { command: 'sleep 0.01', timeoutMs: 600_000 },
      makeExecContext({ workspaceDir: process.cwd() }),
    );
    expect(result.success).toBe(true);
  });

  it('keeps ordinary exec behavior unchanged even with a larger explicit timeout', async () => {
    const audit = makeMockAudit();
    const result = await createExecTool().execute(
      { command: EMPTY_OUTPUT_COMMAND, timeoutMs: 600_000 },
      makeExecContext({ auditWriter: audit, workspaceDir: process.cwd() }),
    );

    expect(result.success).toBe(true);
    expect(audit.write).not.toHaveBeenCalledWith(
      COMMAND_TOOL_AUDIT_EVENTS.EXEC_LONG_BLOCKING_REJECTED,
      expect.anything(),
    );
  });
});
