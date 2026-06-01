/**
 * phase 2 γ4: crash-notification real composer unit test.
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/crash-notification.js';

describe('phase 2: crash-notification composer', () => {
  it('active_unexpected → DAEMON restart CLI', () => {
    const r = composer({ crash_class: 'active_unexpected', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('chestnut claw clawA daemon');
    expect(r!.text).toContain('重启');
  });

  it('active_user_stopped → null FYI (motion 知情即可)', () => {
    const r = composer({ crash_class: 'active_user_stopped', claw_id: 'clawA' });
    expect(r).toBeNull();
  });

  it('unknown crash_class → null fallback', () => {
    const r = composer({ crash_class: 'mystery', claw_id: 'clawA' });
    expect(r).toBeNull();
  });

  it('missing claw_id → fallback <claw-id> placeholder', () => {
    const r = composer({ crash_class: 'active_unexpected', claw_id: '' });
    expect(r!.text).toContain('chestnut claw <claw-id> daemon');
  });
});
