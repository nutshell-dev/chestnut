/**
 * Phase 1193 Step C: archive payload schema positive/negative matrix.
 * Phase 1898: strict subtasks/ record schemas removed (no writer) — only the
 * persisted contract.yaml schema remains covered here.
 */
import { describe, it, expect } from 'vitest';
import { PersistedContractYamlSchema } from '../../../src/core/contract/schemas.js';

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
