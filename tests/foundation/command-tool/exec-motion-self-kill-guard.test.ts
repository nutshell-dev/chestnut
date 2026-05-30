/**
 * exec tool motion-chain self-kill guard (phase 1473).
 *
 * Reject `clawforum stop` / `clawforum motion stop` when ctx.isMotionChain
 * is true. Without the guard, motion would SIGTERM itself, lose the
 * in-flight tool result, and re-issue the command on restart → infinite loop.
 */
import { describe, it, expect, vi } from 'vitest';
import { execTool } from '../../../src/foundation/command-tool/exec.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { makeMockAudit } from '../../helpers/audit.js';

const BLOCKED_MESSAGE = 'motion-chain cannot exec `clawforum stop`';

describe('phase 1473 exec motion-chain self-kill guard', () => {
  it('blocks `clawforum stop` for motion-chain caller', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ isMotionChain: true, auditWriter: audit });

    const result = await execTool.execute({ command: 'clawforum stop' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain(BLOCKED_MESSAGE);
    expect(audit.write).toHaveBeenCalledWith(
      'exec_motion_self_kill_blocked',
      'clawId=test-claw',
      'command=clawforum stop',
    );
  });

  it('blocks `clawforum motion stop` for motion-chain caller', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ isMotionChain: true, auditWriter: audit });

    const result = await execTool.execute({ command: 'clawforum motion stop' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain(BLOCKED_MESSAGE);
    expect(audit.write).toHaveBeenCalledOnce();
  });

  it('blocks even when wrapped (e.g. `pnpm exec clawforum stop`, leading args)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ isMotionChain: true, auditWriter: audit });

    const result = await execTool.execute(
      { command: 'pnpm exec clawforum stop' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(audit.write).toHaveBeenCalledOnce();
  });

  it('does NOT block `clawforum watchdog stop` (out of guard scope)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ isMotionChain: true, auditWriter: audit });

    const result = await execTool.execute(
      { command: 'clawforum watchdog stop' },
      ctx,
    );

    // guard did not fire → no audit emit for blocked event + not the guard message
    expect(audit.write).not.toHaveBeenCalledWith(
      'exec_motion_self_kill_blocked',
      expect.anything(),
      expect.anything(),
    );
    expect(result.content).not.toContain(BLOCKED_MESSAGE);
  });

  it('does NOT block `clawforum status` (read-only)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ isMotionChain: true, auditWriter: audit });

    const result = await execTool.execute({ command: 'clawforum status' }, ctx);

    expect(audit.write).not.toHaveBeenCalledWith(
      'exec_motion_self_kill_blocked',
      expect.anything(),
      expect.anything(),
    );
    expect(result.content).not.toContain(BLOCKED_MESSAGE);
  });

  it('does NOT block non-motion claw (only motion-chain is in scope)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ isMotionChain: false, auditWriter: audit });

    const result = await execTool.execute({ command: 'clawforum stop' }, ctx);

    expect(audit.write).not.toHaveBeenCalledWith(
      'exec_motion_self_kill_blocked',
      expect.anything(),
      expect.anything(),
    );
    expect(result.content).not.toContain(BLOCKED_MESSAGE);
  });

  it('truncates long command in audit emit (cap 200 chars)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ isMotionChain: true, auditWriter: audit });
    const longSuffix = 'a'.repeat(500);
    const longCommand = `clawforum stop ${longSuffix}`;

    await execTool.execute({ command: longCommand }, ctx);

    const writeCall = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    const commandCol = writeCall[2] as string;
    expect(commandCol.length).toBeLessThanOrEqual(200 + 'command='.length);
  });
});
