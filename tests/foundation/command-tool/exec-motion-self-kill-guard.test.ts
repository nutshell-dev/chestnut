/**
 * exec tool self-kill guard integration (phase 758).
 *
 * The guard itself lives in L6 Assembly; this file verifies that
 * `createExecTool(guard)` wires the guard into the exec tool execution path
 * and emits the expected audit event.
 */
import { describe, it, expect, vi } from 'vitest';
import { createExecTool } from '../../../src/foundation/command-tool/exec.js';
import { createAntiSelfKillGuard } from '../../../src/assembly/anti-self-kill.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { makeMockAudit } from '../../helpers/audit.js';

const BLOCKED_MESSAGE = 'motion-chain cannot exec `chestnut stop`';
const guardedExecTool = createExecTool(createAntiSelfKillGuard());

describe('phase 758 exec tool self-kill guard integration', () => {
  it('blocks `chestnut stop` when guard is injected', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ auditWriter: audit });

    const result = await guardedExecTool.execute({ command: 'chestnut stop' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain(BLOCKED_MESSAGE);
    expect(audit.write).toHaveBeenCalledWith(
      'exec_motion_self_kill_blocked',
      'clawId=test-claw',
      expect.stringMatching(/^reason=/),
    );
  });

  it('blocks `chestnut motion stop` when guard is injected', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ auditWriter: audit });

    const result = await guardedExecTool.execute({ command: 'chestnut motion stop' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain(BLOCKED_MESSAGE);
    expect(audit.write).toHaveBeenCalledOnce();
  });

  it('blocks even when wrapped (e.g. `pnpm exec chestnut stop`, leading args)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ auditWriter: audit });

    const result = await guardedExecTool.execute(
      { command: 'pnpm exec chestnut stop' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(audit.write).toHaveBeenCalledOnce();
  });

  it('does NOT block `chestnut watchdog stop` (out of guard scope)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ auditWriter: audit });

    const result = await guardedExecTool.execute(
      { command: 'chestnut watchdog stop' },
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

  it('does NOT block `chestnut status` (read-only)', async () => {
    const audit = makeMockAudit();
    const ctx = makeExecContext({ auditWriter: audit });

    const result = await guardedExecTool.execute({ command: 'chestnut status' }, ctx);

    expect(audit.write).not.toHaveBeenCalledWith(
      'exec_motion_self_kill_blocked',
      expect.anything(),
      expect.anything(),
    );
    expect(result.content).not.toContain(BLOCKED_MESSAGE);
  });
});
