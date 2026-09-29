/**
 * Phase 1925 Step B: .env 极简解析边界测试。
 */
import { describe, it, expect } from 'vitest';
import { parseDotEnv } from '../../../src/foundation/credentials/index.js';

describe('parseDotEnv', () => {
  it('解析 KEY=VALUE、忽略注释与空行、剥引号、忽略 export 前缀', () => {
    const content = [
      '# comment',
      '',
      'A=1',
      'B = spaced ',
      "C='single'",
      'D="double"',
      'export E=exported',
      'F=a=b=c',
      '  # indented comment',
    ].join('\n');
    expect(parseDotEnv(content)).toEqual({
      A: '1',
      B: 'spaced',
      C: 'single',
      D: 'double',
      E: 'exported',
      F: 'a=b=c',
    });
  });

  it('非法行静默忽略；后写覆盖先写；CRLF 兼容', () => {
    expect(parseDotEnv('no-equals-here\r\nA=1\r\n=novalue\r\nA=2\r\n')).toEqual({ A: '2' });
  });

  it('空内容与仅注释 → 空表', () => {
    expect(parseDotEnv('')).toEqual({});
    expect(parseDotEnv('# only\n# comments\n')).toEqual({});
  });
});
