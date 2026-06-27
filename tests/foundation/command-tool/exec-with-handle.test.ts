/**
 * Phase 769 — L2c CommandTool createExecWithHandle tests
 *
 * Verifies the low-level exec handle factory reuses argument resolution and
 * surfaces preExecGuard denials as exceptions.
 */

import { describe, it, expect } from 'vitest';
import { createExecWithHandle } from '../../../src/foundation/command-tool/exec.js';
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
