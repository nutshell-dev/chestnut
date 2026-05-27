/**
 * Phase 1139 — foundation/errors.ts logic dedicated unit test
 *
 * 覆盖: isProgrammingBug / ClawError.toJSON / CliError dual ctor
 */
import { describe, it, expect } from 'vitest';
import {
  ClawError,
  isProgrammingBug,
  CliError,
  type ErrorCode,
} from '../../src/foundation/errors.js';

class TestError extends ClawError {
  readonly code: ErrorCode = 'UNKNOWN_ERROR';
}

describe('foundation/errors — isProgrammingBug', () => {
  it('case 1: TypeError → true', () => {
    expect(isProgrammingBug(new TypeError('x'))).toBe(true);
  });

  it('case 2: ReferenceError + SyntaxError + RangeError → true', () => {
    expect(isProgrammingBug(new ReferenceError('x'))).toBe(true);
    expect(isProgrammingBug(new SyntaxError('x'))).toBe(true);
    expect(isProgrammingBug(new RangeError('x'))).toBe(true);
  });

  it('case 3: 普通 Error → false', () => {
    expect(isProgrammingBug(new Error('regular'))).toBe(false);
  });

  it('case 4: non-Error value → false', () => {
    expect(isProgrammingBug('string error')).toBe(false);
    expect(isProgrammingBug(null)).toBe(false);
    expect(isProgrammingBug(undefined)).toBe(false);
  });
});

describe('foundation/errors — ClawError.toJSON', () => {
  it('case 5: 含 context 不含 cause → JSON 字段齐 + 0 cause field', () => {
    const e = new TestError('msg', { x: 1 });
    const json = e.toJSON();
    expect(json).toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: 'msg',
      context: { x: 1 },
    });
    expect('cause' in json).toBe(false);
  });

  it('case 6: 含 cause → cause field 含 formatErr 结果', () => {
    const inner = new Error('inner cause');
    const e = new TestError('outer', { x: 1 }, inner);
    const json = e.toJSON();
    expect(json.cause).toBeDefined();
    expect(typeof json.cause === 'string' || typeof json.cause === 'object').toBe(true);
  });
});

describe('foundation/errors — CliError dual ctor', () => {
  it('case 7: 数字 ctor → code = number', () => {
    const e = new CliError('msg', 42);
    expect(e.code).toBe(42);
    expect(e.message).toBe('msg');
    expect(e.cause).toBeUndefined();
  });

  it('case 8: options ctor with cause + code → code 取自 options', () => {
    const inner = new Error('inner');
    const e = new CliError('msg', { cause: inner, code: 7 });
    expect(e.code).toBe(7);
    expect(e.cause).toBe(inner);
  });

  it('case 9: 无参 default code = 1', () => {
    const e1 = new CliError('msg');
    expect(e1.code).toBe(1);
    const e2 = new CliError('msg', {});
    expect(e2.code).toBe(1);
  });
});
