/**
 * Phase 282 Step A: progress.status derive from subtasks
 */
import { describe, it, expect } from 'vitest';
import { deriveProgressStatus } from '../../../src/core/contract/types.js';

describe('progress.status derive (phase 282 Step A)', () => {
  it('subtasks empty → status=pending', () => {
    const status = deriveProgressStatus({ subtasks: {} });
    expect(status).toBe('pending');
  });

  it('all subtasks completed → status=completed', () => {
    const status = deriveProgressStatus({
      subtasks: {
        t1: { status: 'completed', completed_at: '2024-01-01' },
        t2: { status: 'completed' },
      },
    });
    expect(status).toBe('completed');
  });

  it('all subtasks have force_accepted → status=completed', () => {
    const status = deriveProgressStatus({
      subtasks: {
        t1: { status: 'completed', force_accepted: true },
        t2: { status: 'todo', force_accepted: true },
      },
    });
    expect(status).toBe('completed');
  });

  it('some subtask in_progress → status=running', () => {
    const status = deriveProgressStatus({
      subtasks: {
        t1: { status: 'in_progress' },
        t2: { status: 'todo' },
      },
    });
    expect(status).toBe('running');
  });

  it('mixed todo + completed (not all completed) → status=running', () => {
    const status = deriveProgressStatus({
      subtasks: {
        t1: { status: 'completed' },
        t2: { status: 'todo' },
      },
    });
    expect(status).toBe('running');
  });

  it('subtask with completed_at but status=todo → still counts as completed for derive', () => {
    const status = deriveProgressStatus({
      subtasks: {
        t1: { status: 'todo', completed_at: '2024-01-01' },
      },
    });
    expect(status).toBe('completed');
  });

  it('subtask with force_accepted but status=todo → still counts as completed for derive', () => {
    const status = deriveProgressStatus({
      subtasks: {
        t1: { status: 'todo', force_accepted: true },
      },
    });
    expect(status).toBe('completed');
  });
});
