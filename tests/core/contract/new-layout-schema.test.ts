/**
 * Phase 1134 Step B: new-layout schema positive/negative matrix.
 */
import { describe, it, expect } from 'vitest';
import {
  PersistedContractYamlSchema,
  VerificationAttemptRecordSchema,
  SubtaskRuntimeRecordSchema,
} from '../../../src/core/contract/schemas.js';

describe('PersistedContractYamlSchema', () => {
  const base = {
    schema_version: 1,
    title: 'T',
    goal: 'G',
    subtasks: [{ id: 't1', description: 'D1' }],
  };

  it('accepts persisted yaml with id', () => {
    const result = PersistedContractYamlSchema.safeParse({ ...base, id: 'cid-1' });
    expect(result.success).toBe(true);
  });

  it('rejects persisted yaml without id', () => {
    const result = PersistedContractYamlSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'id')).toBe(true);
    }
  });

  it('rejects empty id', () => {
    const result = PersistedContractYamlSchema.safeParse({ ...base, id: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'id')).toBe(true);
    }
  });

  it('rejects unknown field', () => {
    const result = PersistedContractYamlSchema.safeParse({ ...base, id: 'cid-1', extra: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          i => i.path.length === 0 && i.message.includes('extra'),
        ),
      ).toBe(true);
    }
  });
});

describe('VerificationAttemptRecordSchema', () => {
  const base = {
    id: 'a1',
    status: 'running',
    started_at: '2026-07-19T10:00:00Z',
    evidence: 'ev',
    artifacts: [],
  };

  it('accepts running attempt without finished_at', () => {
    const result = VerificationAttemptRecordSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('accepts terminal attempt with finished_at', () => {
    const result = VerificationAttemptRecordSchema.safeParse({
      ...base,
      status: 'rejected',
      finished_at: '2026-07-19T10:05:00Z',
      feedback: 'bad',
    });
    expect(result.success).toBe(true);
  });

  it('rejects terminal attempt missing finished_at', () => {
    const result = VerificationAttemptRecordSchema.safeParse({
      ...base,
      status: 'passed',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'finished_at')).toBe(true);
    }
  });

  it('rejects running attempt with finished_at', () => {
    const result = VerificationAttemptRecordSchema.safeParse({
      ...base,
      finished_at: '2026-07-19T10:05:00Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'finished_at')).toBe(true);
    }
  });
});

describe('SubtaskRuntimeRecordSchema', () => {
  function makeRecord(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: 1,
      subtask_id: 't1',
      status: 'todo',
      attempts: [],
      ...overrides,
    };
  }

  it('accepts todo record', () => {
    expect(SubtaskRuntimeRecordSchema.safeParse(makeRecord()).success).toBe(true);
  });

  it('accepts completed record with completed_at', () => {
    expect(
      SubtaskRuntimeRecordSchema.safeParse(
        makeRecord({ status: 'completed', completed_at: '2026-07-19T10:00:00Z' }),
      ).success,
    ).toBe(true);
  });

  it('accepts verifying record referencing exactly one running attempt', () => {
    expect(
      SubtaskRuntimeRecordSchema.safeParse(
        makeRecord({
          status: 'verifying',
          current_attempt_id: 'a1',
          attempts: [
            {
              id: 'a1',
              status: 'running',
              started_at: '2026-07-19T10:00:00Z',
              evidence: 'ev',
              artifacts: [],
            },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects duplicate attempt ids', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(
      makeRecord({
        attempts: [
          {
            id: 'a1',
            status: 'passed',
            started_at: '2026-07-19T10:00:00Z',
            finished_at: '2026-07-19T10:05:00Z',
            evidence: 'ev',
            artifacts: [],
          },
          {
            id: 'a1',
            status: 'rejected',
            started_at: '2026-07-19T10:00:00Z',
            finished_at: '2026-07-19T10:05:00Z',
            evidence: 'ev',
            artifacts: [],
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'attempts')).toBe(true);
    }
  });

  it('rejects verifying with no running attempt', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(
      makeRecord({
        status: 'verifying',
        current_attempt_id: 'a1',
        attempts: [],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'current_attempt_id')).toBe(true);
    }
  });

  it('rejects verifying with wrong current_attempt_id', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(
      makeRecord({
        status: 'verifying',
        current_attempt_id: 'a2',
        attempts: [
          {
            id: 'a1',
            status: 'running',
            started_at: '2026-07-19T10:00:00Z',
            evidence: 'ev',
            artifacts: [],
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'current_attempt_id')).toBe(true);
    }
  });

  it('rejects todo record with current_attempt_id', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(
      makeRecord({ current_attempt_id: 'a1' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'current_attempt_id')).toBe(true);
    }
  });

  it('rejects todo record with a running attempt', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(
      makeRecord({
        attempts: [
          {
            id: 'a1',
            status: 'running',
            started_at: '2026-07-19T10:00:00Z',
            evidence: 'ev',
            artifacts: [],
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'current_attempt_id')).toBe(true);
    }
  });

  it('rejects completed record without completed_at', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(makeRecord({ status: 'completed' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'completed_at')).toBe(true);
    }
  });

  it('rejects non-completed record with completed_at', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(
      makeRecord({ completed_at: '2026-07-19T10:00:00Z' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'completed_at')).toBe(true);
    }
  });

  it('rejects force_accepted for non-completed', () => {
    const result = SubtaskRuntimeRecordSchema.safeParse(
      makeRecord({ force_accepted: true }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'force_accepted')).toBe(true);
    }
  });
});
