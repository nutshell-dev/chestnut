/**
 * Anti-self-kill guard (phase 758).
 *
 * Moved from L2c command-tool/exec.ts to L6 Assembly.
 */
import { describe, it, expect } from 'vitest';
import { createAntiSelfKillGuard } from '../../src/assembly/anti-self-kill.js';

describe('phase 758 assembly anti-self-kill guard', () => {
  it('blocks `chestnut stop`', () => {
    const guard = createAntiSelfKillGuard();
    const result = guard('chestnut stop');

    expect(result.allow).toBe(false);
    expect('reason' in result ? result.reason : '').toContain(
      'motion-chain cannot exec `chestnut stop`',
    );
  });

  it('blocks `chestnut motion stop`', () => {
    const guard = createAntiSelfKillGuard();
    const result = guard('chestnut motion stop');

    expect(result.allow).toBe(false);
  });

  it('blocks when wrapped (e.g. `pnpm exec chestnut stop`)', () => {
    const guard = createAntiSelfKillGuard();
    const result = guard('pnpm exec chestnut stop');

    expect(result.allow).toBe(false);
  });

  it('does NOT block `chestnut watchdog stop`', () => {
    const guard = createAntiSelfKillGuard();
    const result = guard('chestnut watchdog stop');

    expect(result.allow).toBe(true);
  });

  it('does NOT block `chestnut status`', () => {
    const guard = createAntiSelfKillGuard();
    const result = guard('chestnut status');

    expect(result.allow).toBe(true);
  });

  it('allows unrelated commands', () => {
    const guard = createAntiSelfKillGuard();
    const result = guard('ls -la');

    expect(result.allow).toBe(true);
  });
});
