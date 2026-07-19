/**
 * Phase 1132 Step B: status tuples / types / Sets runtime invariant tests
 *
 * Current lifecycle is path-derived (active / archive/<state>); progress.json
 * status is legacy-only. This file guards the disjoint vocabulary boundary
 * between derivable progress aggregate, archive state directories, and the
 * legacy flat-archive status vocabulary.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  DERIVABLE_STATUSES_TUPLE,
  DERIVABLE_STATUSES,
  SUBTASK_STATUSES_TUPLE,
  SUBTASK_STATUSES,
  deriveProgressStatus,
  stripDerivableStatus,
  stripProgressDerivedFields,
  ARCHIVE_STATE_DIRS_TUPLE,
  ARCHIVE_STATES,
} from '../../../src/core/contract/types.js';
import { LEGACY_PROGRESS_STATUSES_TUPLE } from '../../../src/core/contract/schemas.js';

describe('phase 1132 Step B: status vocabulary boundary invariants', () => {
  describe('Invariant 1: DERIVABLE_STATUSES_TUPLE ↔ DERIVABLE_STATUSES Set', () => {
    it('every tuple element ∈ Set', () => {
      for (const literal of DERIVABLE_STATUSES_TUPLE) {
        expect(DERIVABLE_STATUSES.has(literal)).toBe(true);
      }
    });

    it('Set.size === tuple.length (no duplicates)', () => {
      expect(DERIVABLE_STATUSES.size).toBe(DERIVABLE_STATUSES_TUPLE.length);
    });

    it('Set.size === 3 (pending/running/completed)', () => {
      expect(DERIVABLE_STATUSES.size).toBe(3);
    });
  });

  describe('Invariant 2: LEGACY_PROGRESS_STATUSES_TUPLE accepts historical flat-archive values', () => {
    const LegacySchema = z.enum(LEGACY_PROGRESS_STATUSES_TUPLE);

    it('z.enum.parse accepts all legacy literals', () => {
      for (const literal of LEGACY_PROGRESS_STATUSES_TUPLE) {
        expect(() => LegacySchema.parse(literal)).not.toThrow();
      }
    });

    it('z.enum.parse rejects unknown literal', () => {
      expect(() => LegacySchema.parse('unknown_status')).toThrow();
    });

    it('legacy tuple has exactly 8 literals (derivable + lifecycle + paused)', () => {
      expect(LEGACY_PROGRESS_STATUSES_TUPLE.length).toBe(8);
    });

    it('legacy tuple contains paused/crashed/archive_pending_recovery/archive_corrupted', () => {
      const set = new Set(LEGACY_PROGRESS_STATUSES_TUPLE);
      expect(set.has('paused')).toBe(true);
      expect(set.has('crashed')).toBe(true);
      expect(set.has('archive_pending_recovery')).toBe(true);
      expect(set.has('archive_corrupted')).toBe(true);
    });
  });

  describe('Invariant 3: ARCHIVE_STATE_DIRS_TUPLE ↔ ARCHIVE_STATES Set', () => {
    it('every tuple element ∈ Set', () => {
      for (const literal of ARCHIVE_STATE_DIRS_TUPLE) {
        expect(ARCHIVE_STATES.has(literal)).toBe(true);
      }
    });

    it('Set.size === tuple.length (no duplicates)', () => {
      expect(ARCHIVE_STATES.size).toBe(ARCHIVE_STATE_DIRS_TUPLE.length);
    });

    it('archive state dirs are completed/cancelled/corrupted', () => {
      expect(ARCHIVE_STATE_DIRS_TUPLE).toEqual(['completed', 'cancelled', 'corrupted']);
    });
  });

  describe('Invariant 4: deriveProgressStatus return ⊆ DERIVABLE_STATUSES', () => {
    it('empty subtasks → pending', () => {
      const result = deriveProgressStatus({ subtasks: {} });
      expect(DERIVABLE_STATUSES.has(result)).toBe(true);
      expect(result).toBe('pending');
    });

    it('all subtasks completed → completed', () => {
      const result = deriveProgressStatus({
        subtasks: {
          'st-1': { status: 'completed' },
          'st-2': { status: 'completed' },
        },
      });
      expect(DERIVABLE_STATUSES.has(result)).toBe(true);
      expect(result).toBe('completed');
    });

    it('all subtasks with completed_at → completed (derive via completed_at)', () => {
      const result = deriveProgressStatus({
        subtasks: {
          'st-1': { status: 'todo', completed_at: '2026-01-01' },
        },
      });
      expect(DERIVABLE_STATUSES.has(result)).toBe(true);
      expect(result).toBe('completed');
    });

    it('mixed subtasks → running', () => {
      const result = deriveProgressStatus({
        subtasks: {
          'st-1': { status: 'completed' },
          'st-2': { status: 'todo' },
        },
      });
      expect(DERIVABLE_STATUSES.has(result)).toBe(true);
      expect(result).toBe('running');
    });

    it('force_accepted treated as completed (phase 1399 backwards-compat)', () => {
      const result = deriveProgressStatus({
        subtasks: {
          'st-1': { status: 'todo', force_accepted: true },
        },
      });
      expect(DERIVABLE_STATUSES.has(result)).toBe(true);
      expect(result).toBe('completed');
    });
  });

  describe('Invariant 6: stripDerivableStatus 对称 (derivable→strip / non-derivable→preserve)', () => {
    it('strips derivable: pending', () => {
      const obj: Record<string, unknown> = { status: 'pending', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBeUndefined();
    });

    it('strips derivable: running', () => {
      const obj: Record<string, unknown> = { status: 'running', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBeUndefined();
    });

    it('strips derivable: completed', () => {
      const obj: Record<string, unknown> = { status: 'completed', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBeUndefined();
    });

    it('preserves non-derivable: cancelled', () => {
      const obj: Record<string, unknown> = { status: 'cancelled', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBe('cancelled');
    });

    it('preserves non-derivable: crashed', () => {
      const obj: Record<string, unknown> = { status: 'crashed', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBe('crashed');
    });

    it('preserves non-derivable: archive_pending_recovery', () => {
      const obj: Record<string, unknown> = { status: 'archive_pending_recovery', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBe('archive_pending_recovery');
    });

    it('preserves non-derivable: archive_corrupted', () => {
      const obj: Record<string, unknown> = { status: 'archive_corrupted', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBe('archive_corrupted');
    });

    it('preserves unknown string (loose、不 strip)', () => {
      const obj: Record<string, unknown> = { status: 'unknown_future_status', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBe('unknown_future_status');
    });

    it('preserves undefined status', () => {
      const obj: Record<string, unknown> = { subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBeUndefined();
    });
  });

  describe('Invariant 7: SUBTASK_STATUSES_TUPLE ↔ SUBTASK_STATUSES Set', () => {
    it('every tuple element ∈ Set', () => {
      for (const literal of SUBTASK_STATUSES_TUPLE) {
        expect(SUBTASK_STATUSES.has(literal)).toBe(true);
      }
    });

    it('Set.size === tuple.length (no duplicates)', () => {
      expect(SUBTASK_STATUSES.size).toBe(SUBTASK_STATUSES_TUPLE.length);
    });

    it('Set.size === 3 (todo/in_progress/completed)', () => {
      expect(SUBTASK_STATUSES.size).toBe(3);
    });
  });

  describe('Invariant 8: SUBTASK_STATUSES z.enum 接受 all + reject unknown', () => {
    const SubtaskEnum = z.enum(SUBTASK_STATUSES_TUPLE);

    it('z.enum.parse accepts all tuple members', () => {
      for (const literal of SUBTASK_STATUSES_TUPLE) {
        expect(() => SubtaskEnum.parse(literal)).not.toThrow();
      }
    });

    it('z.enum.parse rejects unknown literal', () => {
      expect(() => SubtaskEnum.parse('unknown_subtask_status')).toThrow();
      expect(() => SubtaskEnum.parse('pending')).toThrow();      // contract status, not subtask
      expect(() => SubtaskEnum.parse('running')).toThrow();
      expect(() => SubtaskEnum.parse('paused')).toThrow();
    });
  });

  describe('Invariant 9: stripProgressDerivedFields removes contract_id and any status', () => {
    it('removes contract_id', () => {
      const obj: Record<string, unknown> = { contract_id: 'c1', subtasks: {} };
      stripProgressDerivedFields(obj);
      expect(obj.contract_id).toBeUndefined();
    });

    it('removes derivable status: completed', () => {
      const obj: Record<string, unknown> = { status: 'completed', subtasks: {} };
      stripProgressDerivedFields(obj);
      expect(obj.status).toBeUndefined();
    });

    it('removes lifecycle status: cancelled', () => {
      const obj: Record<string, unknown> = { status: 'cancelled', subtasks: {} };
      stripProgressDerivedFields(obj);
      expect(obj.status).toBeUndefined();
    });

    it('removes legacy status: paused', () => {
      const obj: Record<string, unknown> = { status: 'paused', subtasks: {} };
      stripProgressDerivedFields(obj);
      expect(obj.status).toBeUndefined();
    });

    it('removes unknown status', () => {
      const obj: Record<string, unknown> = { status: 'unknown_future_status', subtasks: {} };
      stripProgressDerivedFields(obj);
      expect(obj.status).toBeUndefined();
    });

    it('leaves subtasks intact', () => {
      const obj: Record<string, unknown> = { status: 'running', subtasks: { t1: { status: 'todo' } } };
      stripProgressDerivedFields(obj);
      expect(obj.subtasks).toEqual({ t1: { status: 'todo' } });
    });
  });

  describe('Invariant 10: SUBTASK_STATUSES ∩ DERIVABLE_STATUSES = {completed}', () => {
    it('only completed literal shared between SUBTASK and DERIVABLE', () => {
      const overlap = SUBTASK_STATUSES_TUPLE.filter(s =>
        (DERIVABLE_STATUSES as ReadonlySet<string>).has(s),
      );
      expect(overlap).toEqual(['completed']);
    });

    it('todo not in DerivableStatus', () => {
      expect((DERIVABLE_STATUSES as ReadonlySet<string>).has('todo')).toBe(false);
    });

    it('in_progress not in DerivableStatus', () => {
      expect((DERIVABLE_STATUSES as ReadonlySet<string>).has('in_progress')).toBe(false);
    });
  });
});
