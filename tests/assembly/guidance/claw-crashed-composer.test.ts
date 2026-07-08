/**
 * phase 2 γ4 + phase 4 重写 + phase 201: claw-crashed real composer unit test.
 * phase 201: unknown → fallback guidance / active_user_stopped → read-only inspect guidance.
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/claw-crashed.js';

describe('claw-crashed composer', () => {
  it('active_unexpected → 2-line guidance: restart + diagnostic CLI (phase 4)', () => {
    const r = composer({ crash_class: 'active_unexpected', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To restart: chestnut claw clawA daemon');
    expect(r.text).toContain('To inspect what the claw was doing before crash: chestnut claw clawA steps');
  });

  it('active_user_stopped → read-only inspect guidance (status + steps)、不附 restart 暗示 (phase 201)', () => {
    const r = composer({ crash_class: 'active_user_stopped', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To check current status: chestnut claw clawA status');
    expect(r.text).toContain('To inspect what the claw was doing: chestnut claw clawA steps');
    expect(r.text).not.toContain('daemon');
  });

  it('unknown crash_class → fallback guidance (phase 201 删 null 旁路)', () => {
    const r = composer({ crash_class: 'mystery', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect: chestnut claw clawA steps');
  });

  it('missing claw_id → fallback <claw-id> placeholder', () => {
    const r = composer({ crash_class: 'active_unexpected', claw_id: '' });
    expect(r.text).toContain('chestnut claw <claw-id> daemon');
    expect(r.text).toContain('chestnut claw <claw-id> steps');
  });
});
