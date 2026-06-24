/**
 * Phase 1139 — foundation/errors.ts logic dedicated unit test
 *
 * 覆盖: ClawError.toJSON
 */
import { describe, it, expect } from 'vitest';
import {
  ClawError,
  type ErrorCode,
} from '../../src/foundation/errors.js';

class TestError extends ClawError {
  readonly code: ErrorCode = 'UNKNOWN_ERROR';
}

describe('foundation/errors — ClawError.toJSON', () => {
  it('case 1: 含 context 不含 cause → JSON 字段齐 + 0 cause field', () => {
    const e = new TestError('msg', { x: 1 });
    const json = e.toJSON();
    expect(json).toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: 'msg',
      context: { x: 1 },
    });
    expect('cause' in json).toBe(false);
  });

  it('case 2: 含 cause → cause field 含 formatErr 结果', () => {
    const inner = new Error('inner cause');
    const e = new TestError('outer', { x: 1 }, inner);
    const json = e.toJSON();
    expect(json.cause).toBeDefined();
    expect(typeof json.cause === 'string' || typeof json.cause === 'object').toBe(true);
  });
});
