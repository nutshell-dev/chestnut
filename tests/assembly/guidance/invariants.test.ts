/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - task-queue-overflow-composer.test.ts
 *  - claw-outbox-summary-composer.test.ts
 */

import { describe, it, expect } from 'vitest';
import { composer as taskQueueOverflowComposer } from '../../../src/assembly/guidance/composers/task-queue-overflow.js';
import { composer as clawOutboxSummaryComposer } from '../../../src/assembly/guidance/composers/claw-outbox-summary.js';

describe('task-queue-overflow-composer', () => {
  /**
   * phase 7 γ7: task-queue-overflow real composer unit test.
   */

  describe('task-queue-overflow composer (phase 7)', () => {
    it('returns escalation guidance pointing to user', () => {
      const r = taskQueueOverflowComposer({ cap: '1000', queue_length: '1000' });
      expect(r.text).toContain('system-level overload');
      expect(r.text).toContain('Surface to the user');
      expect(r.text).toContain('developer');
      expect(r.text).toContain('Do not retry');
    });

    it('returns same guidance regardless of state fields', () => {
      const r1 = taskQueueOverflowComposer({});
      const r2 = taskQueueOverflowComposer({ cap: '500', queue_length: '500' });
      expect(r1.text).toBe(r2.text);
    });
  });
});

describe('claw-outbox-summary-composer', () => {
  /**
   * phase 1476: claw-outbox-summary composer unit test (γ2 first real composer).
   */

  describe('phase 1476: claw-outbox-summary composer', () => {
    it('returns non-null guidance with subject-first CLI', () => {
      const result = clawOutboxSummaryComposer({
        hash: 'abc123def456',
        total_claws: '2',
        total_msgs: '4',
        counts: JSON.stringify({ clawA: 3, clawB: 1 }),
      });
      expect(result.text).toContain('chestnut claw <claw-id> outbox');
      expect(result.text).toContain('--limit 4');
    });

    it('safe limit fallback if total_msgs is malformed', () => {
      const result = clawOutboxSummaryComposer({
        hash: 'aaaaaaaaaaaa',
        total_claws: '1',
        total_msgs: 'NaN',
        counts: '{}',
      });
      expect(result.text).toContain('--limit 10');
    });

    it('total_msgs = 0 still returns guidance (caller decides to call or not)', () => {
      // composer is pure / doesn't second-guess scheduler — tick handler guards 0-unread case
      const result = clawOutboxSummaryComposer({
        hash: 'aaaaaaaaaaaa',
        total_claws: '0',
        total_msgs: '0',
        counts: '{}',
      });
      expect(result.text).toContain('--limit 10'); // fallback when limit <= 0
    });
  });
});
