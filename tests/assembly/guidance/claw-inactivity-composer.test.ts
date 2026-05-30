/**
 * phase 1482: claw-inactivity real composer unit test (γ3 first real, 2nd overall).
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/claw-inactivity.js';

describe('phase 1482: claw-inactivity composer', () => {
  it('daemon_stopped → DAEMON restart CLI', () => {
    const r = composer({ failure_class: 'daemon_stopped', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('clawforum claw clawA daemon');
    expect(r!.text).toContain('重启');
  });

  it('daemon_silent → STEPS CLI', () => {
    const r = composer({ failure_class: 'daemon_silent', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('clawforum claw clawA steps');
    expect(r!.text).toContain('stuck');
  });

  it('daemon_errored → STEPS CLI', () => {
    const r = composer({ failure_class: 'daemon_errored', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('clawforum claw clawA steps');
    expect(r!.text).toContain('error context');
  });

  it('unknown failure_class → null (Runtime fallback graceful)', () => {
    const r = composer({ failure_class: 'mystery_class', claw_id: 'clawA' });
    expect(r).toBeNull();
  });

  it('missing claw_id → fallback <claw-id> placeholder', () => {
    const r = composer({ failure_class: 'daemon_stopped', claw_id: '' });
    expect(r!.text).toContain('clawforum claw <claw-id> daemon');
  });
});
