import { describe, it, expect } from 'vitest';
import { formatErr } from '../../../src/foundation/node-utils/format.js';

/**
 * phase 13 — formatErr owner 治本 行为契约测试
 *
 * Design Principle「运行中产生的任何信息、未经显式设计决策，不得丢弃或静默忽略」。
 * 旧实现 String(err) 对 non-Error 落 [object Object]、违反原则。
 * 本测试断言新行为契约：所有 unknown 形态返回非 [object Object] 单行可观察字符串。
 *
 * 行为契约见 coding plan/phase13/Phase 13 总览.md §2 + §4.4。
 */
describe('phase 13 formatErr behavior contract', () => {
  describe('Error 分支', () => {
    it('普通 Error: 返回 err.message', () => {
      expect(formatErr(new Error('boom'))).toBe('boom');
    });

    it('空 message Error: 退化到 err.name', () => {
      const e = new Error('');
      expect(formatErr(e)).toBe('Error');
    });

    it('子类 Error: 仍取 message', () => {
      class MyErr extends Error {}
      expect(formatErr(new MyErr('custom'))).toBe('custom');
    });

    it('Error.cause = Error: 用 -> caused by: 连接', () => {
      const inner = new Error('inner');
      const outer = new Error('outer', { cause: inner });
      expect(formatErr(outer)).toBe('outer -> caused by: inner');
    });

    it('Error.cause = plain object: 走 inspect 展开', () => {
      const outer = new Error('outer', { cause: { code: 'X' } });
      const out = formatErr(outer);
      expect(out).toContain('outer -> caused by:');
      expect(out).toContain("code:");
      expect(out).toContain("'X'");
    });

    it('Error.cause = string: 直接展开', () => {
      const outer = new Error('outer', { cause: 'raw' });
      expect(formatErr(outer)).toBe('outer -> caused by: raw');
    });

    it('Error.cause 多层链: 递归展开', () => {
      const a = new Error('a');
      const b = new Error('b', { cause: a });
      const c = new Error('c', { cause: b });
      expect(formatErr(c)).toBe('c -> caused by: b -> caused by: a');
    });

    it('Error.cause 深度超 8: 截断 [depth-limit]', () => {
      let last: Error = new Error('leaf');
      for (let i = 0; i < 12; i++) last = new Error(`L${i}`, { cause: last });
      const out = formatErr(last);
      expect(out).toContain('[depth-limit]');
      // 终止保证：不抛、不死循环
    });
  });

  describe('plain object / Array 分支（旧 bug 核心）', () => {
    it('plain object: 不返回 [object Object]', () => {
      const out = formatErr({ a: 1 });
      expect(out).not.toBe('[object Object]');
      expect(out).toContain('a:');
      expect(out).toContain('1');
    });

    it('嵌套 object: depth=2 展开', () => {
      const out = formatErr({ a: { b: 1 } });
      expect(out).not.toBe('[object Object]');
      expect(out).toContain('b:');
    });

    it('Array: 展开元素', () => {
      const out = formatErr([1, 2, 3]);
      expect(out).not.toBe('[object Object]');
      expect(out).toMatch(/\[.*1.*2.*3.*\]/);
    });

    it('circular reference: util.inspect 标记 [Circular]、不抛', () => {
      const o: any = { a: 1 };
      o.self = o;
      const out = formatErr(o);
      expect(out).not.toBe('[object Object]');
      expect(out).toContain('Circular');
    });

    it('返回值单行（无 \\n）', () => {
      const big = { lines: ['a', 'b', 'c'].map((s) => ({ s, n: 1 })) };
      const out = formatErr(big);
      expect(out).not.toContain('\n');
    });

    it('特殊错误形态对象（仿 reject({ code, message })）: 走 inspect 展开', () => {
      const out = formatErr({ code: 'EX', message: 'bad' });
      expect(out).not.toBe('[object Object]');
      expect(out).toContain("code:");
      expect(out).toContain("'EX'");
      expect(out).toContain("message:");
      expect(out).toContain("'bad'");
    });
  });

  describe('primitive / null / undefined 分支', () => {
    it('null', () => {
      expect(formatErr(null)).toBe('null');
    });

    it('undefined', () => {
      expect(formatErr(undefined)).toBe('undefined');
    });

    it('string', () => {
      expect(formatErr('plain')).toBe('plain');
    });

    it('number', () => {
      expect(formatErr(42)).toBe('42');
    });

    it('boolean', () => {
      expect(formatErr(true)).toBe('true');
    });

    it('bigint', () => {
      expect(formatErr(BigInt(10))).toBe('10');
    });

    it('Symbol', () => {
      expect(formatErr(Symbol('s'))).toBe('Symbol(s)');
    });
  });

  describe('行为契约不变（兼容旧 caller）', () => {
    it('签名 (unknown) => string、不抛任何输入', () => {
      const inputs: unknown[] = [
        new Error('e'), { x: 1 }, null, undefined, 0, '',
        BigInt(0), Symbol(), [1, 2], NaN, Infinity, () => 1,
      ];
      for (const v of inputs) {
        expect(typeof formatErr(v)).toBe('string');
      }
    });
  });
});
