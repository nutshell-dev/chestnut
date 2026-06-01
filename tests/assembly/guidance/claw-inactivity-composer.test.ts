/**
 * phase 1482 + phase 2 reframe: claw-inactivity real composer unit test.
 * daemon_stopped case 已移除（归 crash_notification composer 覆盖）.
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/claw-inactivity.js';

describe('phase 1482 + phase 2: claw-inactivity composer', () => {
  it('daemon_silent → STEPS CLI', () => {
    const r = composer({ failure_class: 'daemon_silent', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('chestnut claw clawA steps');
    expect(r!.text).toContain('stuck');
  });

  it('daemon_errored → STEPS CLI', () => {
    const r = composer({ failure_class: 'daemon_errored', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('chestnut claw clawA steps');
    expect(r!.text).toContain('error context');
  });

  it('daemon_stopped → null (phase 2 移出归 crash_notification composer)', () => {
    const r = composer({ failure_class: 'daemon_stopped', claw_id: 'clawA' });
    expect(r).toBeNull();
  });

  it('unknown failure_class → null (Runtime fallback graceful)', () => {
    const r = composer({ failure_class: 'mystery_class', claw_id: 'clawA' });
    expect(r).toBeNull();
  });

  it('missing claw_id (daemon_silent) → fallback <claw-id> placeholder', () => {
    const r = composer({ failure_class: 'daemon_silent', claw_id: '' });
    expect(r!.text).toContain('chestnut claw <claw-id> steps');
  });
});
