/**
 * Phase 360: status tuples / types / Sets runtime invariant tests
 *
 * cluster N=15 status type system 圆满收口 (phase 282 → 311 → 319 → 330 → 332 →
 * 335 → 338 → 341 → 342 → 344 → 345 → 347 → 348 → 351 → 352 → 356 → 358) 之
 * runtime anti-regression 守护。
 *
 * 5 invariants:
 * 1. DERIVABLE_STATUSES_TUPLE 与 DERIVABLE_STATUSES Set 一致 (Set member + size)
 * 2. LIFECYCLE_PERSISTED_STATUSES_TUPLE 与 LifecyclePersistedStatus type 一致 (z.enum parse all + reject unknown)
 * 3. ALL_CONTRACT_STATUSES_TUPLE = DERIVABLE ∪ LIFECYCLE_PERSISTED (length sum + disjoint)
 * 4. deriveProgressStatus return ⊆ DERIVABLE_STATUSES (mock progress 多 input)
 * 5. stripDerivableStatus 对称 (derivable → strip / non-derivable → preserve)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  DERIVABLE_STATUSES_TUPLE,
  DERIVABLE_STATUSES,
  ALL_CONTRACT_STATUSES_TUPLE,
  ALL_CONTRACT_STATUSES,
  SUBTASK_STATUSES_TUPLE,
  SUBTASK_STATUSES,
  deriveProgressStatus,
  stripDerivableStatus,
} from '../../../src/core/contract/types.js';
import { LIFECYCLE_PERSISTED_STATUSES_TUPLE } from '../../../src/core/contract/schemas.js';

describe('phase 360: status tuples / types / Sets runtime invariants', () => {
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

  describe('Invariant 2: LIFECYCLE_PERSISTED_STATUSES_TUPLE ↔ LifecyclePersistedStatus type', () => {
    const PersistedSchema = z.enum(LIFECYCLE_PERSISTED_STATUSES_TUPLE);

    it('z.enum.parse accepts all tuple members', () => {
      for (const literal of LIFECYCLE_PERSISTED_STATUSES_TUPLE) {
        expect(() => PersistedSchema.parse(literal)).not.toThrow();
      }
    });

    it('z.enum.parse rejects unknown literal', () => {
      expect(() => PersistedSchema.parse('unknown_status')).toThrow();
      expect(() => PersistedSchema.parse('pending')).toThrow();  // derivable, not persisted
      expect(() => PersistedSchema.parse('running')).toThrow();
      expect(() => PersistedSchema.parse('completed')).toThrow();
    });

    it('tuple has exactly 4 literals (paused/cancelled/crashed/archive_pending_recovery)', () => {
      expect(LIFECYCLE_PERSISTED_STATUSES_TUPLE.length).toBe(4);
    });
  });

  describe('Invariant 3: ALL_CONTRACT_STATUSES_TUPLE = DERIVABLE ∪ LIFECYCLE_PERSISTED', () => {
    it('tuple.length === DERIVABLE.length + LIFECYCLE_PERSISTED.length', () => {
      expect(ALL_CONTRACT_STATUSES_TUPLE.length).toBe(
        DERIVABLE_STATUSES_TUPLE.length + LIFECYCLE_PERSISTED_STATUSES_TUPLE.length,
      );
    });

    it('All elements unique (disjoint base tuples)', () => {
      expect(ALL_CONTRACT_STATUSES.size).toBe(ALL_CONTRACT_STATUSES_TUPLE.length);
    });

    it('contains all DERIVABLE members', () => {
      for (const literal of DERIVABLE_STATUSES_TUPLE) {
        expect(ALL_CONTRACT_STATUSES.has(literal)).toBe(true);
      }
    });

    it('contains all LIFECYCLE_PERSISTED members', () => {
      for (const literal of LIFECYCLE_PERSISTED_STATUSES_TUPLE) {
        expect(ALL_CONTRACT_STATUSES.has(literal)).toBe(true);
      }
    });

    it('disjoint: no DERIVABLE member ∈ LIFECYCLE_PERSISTED', () => {
      const persistedSet = new Set<string>(LIFECYCLE_PERSISTED_STATUSES_TUPLE);
      for (const literal of DERIVABLE_STATUSES_TUPLE) {
        expect(persistedSet.has(literal)).toBe(false);
      }
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

  describe('Invariant 5: stripDerivableStatus 对称 (derivable→strip / non-derivable→preserve)', () => {
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

    it('preserves non-derivable: paused', () => {
      const obj: Record<string, unknown> = { status: 'paused', subtasks: {} };
      stripDerivableStatus(obj);
      expect(obj.status).toBe('paused');
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

  // phase 362: SubtaskStatus invariants (mirror DerivableStatus pattern)
  describe('Invariant 6: SUBTASK_STATUSES_TUPLE ↔ SUBTASK_STATUSES Set', () => {
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

  describe('Invariant 7: SUBTASK_STATUSES z.enum 接受 all + reject unknown', () => {
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

  describe('Invariant 8: SUBTASK_STATUSES ∩ ALL_CONTRACT_STATUSES = {completed}', () => {
    it('only completed literal shared between SUBTASK and ALL_CONTRACT', () => {
      const overlap = SUBTASK_STATUSES_TUPLE.filter(s =>
        (ALL_CONTRACT_STATUSES as ReadonlySet<string>).has(s),
      );
      expect(overlap).toEqual(['completed']);
    });

    it('todo not in ContractStatus', () => {
      expect((ALL_CONTRACT_STATUSES as ReadonlySet<string>).has('todo')).toBe(false);
    });

    it('in_progress not in ContractStatus', () => {
      expect((ALL_CONTRACT_STATUSES as ReadonlySet<string>).has('in_progress')).toBe(false);
    });
  });

  describe('Invariant 9: tuple length 3 (anti-regression count guard)', () => {
    it('SUBTASK_STATUSES_TUPLE has exactly 3 literals', () => {
      expect(SUBTASK_STATUSES_TUPLE.length).toBe(3);
    });
  });
});
