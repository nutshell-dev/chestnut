/**
 * Phase 769 — L2c CommandTool createExecWithHandle tests
 *
 * Verifies the low-level exec handle factory reuses argument resolution and
 * surfaces preExecGuard denials as exceptions.
 */

import { describe, it, expect } from 'vitest';
import { createExecWithHandle } from '../../../src/foundation/command-tool/exec.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';

describe('createExecWithHandle', () => {
  it('should return ExecHandle for valid command', async () => {
    const execWithHandle = createExecWithHandle();
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const handle = await execWithHandle({ command: 'echo hello' }, ctx);
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('hello');
  });

  it('should resolve workspaceDir-relative cwd', async () => {
    const execWithHandle = createExecWithHandle();
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const handle = await execWithHandle({ command: 'pwd', cwd: '.' }, ctx);
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(process.cwd());
  });

  it('should inject CHESTNUT_SUBAGENT_TASK_ID when ctx.subagentTaskId is set', async () => {
    const execWithHandle = createExecWithHandle();
    const ctx = makeExecContext({
      workspaceDir: process.cwd(),
      subagentTaskId: 'subagent-fixture-456',
    });
    const handle = await execWithHandle({ command: 'echo "$CHESTNUT_SUBAGENT_TASK_ID"' }, ctx);
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('subagent-fixture-456');
  });

  it('should block command when preExecGuard returns false', async () => {
    const execWithHandle = createExecWithHandle(() => ({
      allow: false,
      reason: 'motion self-kill guard',
    }));
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    await expect(execWithHandle({ command: 'kill $$' }, ctx)).rejects.toThrow('motion self-kill guard');
  });

  it('should throw (not return ToolResult) on preExecGuard deny', async () => {
    const execWithHandle = createExecWithHandle(() => ({
      allow: false,
      reason: 'denied',
    }));
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    let threw = false;
    try {
      await execWithHandle({ command: 'true' }, ctx);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('denied');
    }
    expect(threw).toBe(true);
  });
});

/**
 * Phase 1269 Step D — createExecWithHandle identity/terminate 透传不丢字段
 */
describe('createExecWithHandle execution identity passthrough (phase 1269)', () => {
  it('handle carries identity and L1-owned terminate through the L2 factory', async () => {
    const execWithHandle = createExecWithHandle();
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const handle = await execWithHandle({ command: 'sleep 30' }, ctx);

    expect(handle.identity).toBeDefined();
    expect(handle.identity!.leaderPid).toBe(handle.child.pid);
    expect(handle.identity!.processGroupId).toBe(handle.identity!.leaderPid);

    const outcome = await handle.terminate();
    expect(outcome.status).toBe('gone');
    expect(outcome.trigger).toBe('caller_requested');
    expect(outcome.identity).toEqual(handle.identity);

    const err = await handle.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessExecError);
    expect((err as ProcessExecError).termination!.status).toBe('gone');
    expect((err as ProcessExecError).termination!.identity).toEqual(handle.identity);
  }, 15_000);
});


/**
 * Phase 1272 Step C — createExecWithHandle absolute deadline passthrough
 *
 * The low-level factory transparently forwards `deadlineAtMs` (mutually
 * exclusive with `timeoutMs`) to L1; the relative timeoutMs path is
 * behaviorally unchanged. The agent-facing schema never exposes the field.
 */
describe('createExecWithHandle deadline passthrough (phase 1272 Step C)', () => {
  it('forwards deadlineAtMs to L1 untouched (absolute deadline fires, no relative clamp)', async () => {
    const DEADLINE_AHEAD_MS = 50; // ≫ scheduling jitter, ≪ the 30s relative default
    const execWithHandle = createExecWithHandle();
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const handle = await execWithHandle(
      { command: 'sleep 10', deadlineAtMs: Date.now() + DEADLINE_AHEAD_MS },
      ctx,
    );
    const err = await handle.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessExecError);
    const error = err as ProcessExecError;
    expect(error.message).toContain('absolute deadline');
    expect(error.termination!.trigger).toBe('timeout');
    expect(error.termination!.status).toBe('gone');
  }, 15_000);

  it('rejects timeoutMs + deadlineAtMs together instead of silently picking one', async () => {
    const execWithHandle = createExecWithHandle();
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    await expect(
      // @ts-expect-error phase 1272: the two timeout strategies are mutually exclusive at the type level
      execWithHandle({ command: 'true', timeoutMs: 1000, deadlineAtMs: Date.now() + 1000 }, ctx),
    ).rejects.toThrow('mutually exclusive');
  });

  it('relative timeoutMs path is unchanged', async () => {
    const execWithHandle = createExecWithHandle();
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const handle = await execWithHandle({ command: 'echo ok', timeoutMs: 5000 }, ctx);
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('ok');
  });
});
