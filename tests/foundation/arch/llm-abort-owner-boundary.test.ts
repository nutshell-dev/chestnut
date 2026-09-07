/**
 * Phase 1802: LLMProvider abort owner 边界（上层 reason 词汇枚举治理）。
 *
 * - L1 不再声明/导出 AbortReason 枚举；reason 是 opaque evidence（unknown 承载）。
 * - provider 源码不出现上层词汇字面（user/step_yield/turn_timeout/tool_timeout/idle_timeout/priority_inbox）。
 * - message 结构化格式化与旧枚举实现字节兼容（{type, ms} duck-typing）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ExternalAbortError,
  makeExternalAbortError,
} from '../../../src/foundation/llm-provider/index.js';
import * as providerBarrel from '../../../src/foundation/llm-provider/index.js';

const HELPER_SRC = readFileSync(
  new URL('../../../src/foundation/llm-provider/abort-helper.ts', import.meta.url), 'utf8');

const UPPER_VOCAB = ['step_yield', 'turn_timeout', 'tool_timeout', 'idle_timeout', 'priority_inbox'];

describe('llm abort owner boundary (phase 1802)', () => {
  it('abort-helper.ts 无 AbortReason 枚举、无上层词汇字面', () => {
    expect(HELPER_SRC).not.toMatch(/export\s+type\s+AbortReason/);
    const noComments = HELPER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const word of UPPER_VOCAB) {
      expect(noComments).not.toContain(`'${word}'`);
    }
  });

  it('llm-provider 全部源码文件不枚举上层 reason 字面', () => {
    const dir = new URL('../../../src/foundation/llm-provider/', import.meta.url);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(new URL(f, dir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const word of UPPER_VOCAB) {
        expect(src, `${f} must not reference '${word}'`).not.toContain(`'${word}'`);
      }
    }
  });

  it('barrel 不再导出 AbortReason 类型', () => {
    // 运行期侧面：ExternalAbortError 在、枚举类型不在（type-only 无运行期痕迹，源码锁兜底）
    expect(typeof providerBarrel.ExternalAbortError).toBe('function');
    expect('AbortReason' in providerBarrel).toBe(false);
  });

  it('message 结构化格式化与旧枚举字节兼容（{type,ms} / {type} / 无 reason）', () => {
    expect(makeExternalAbortError({ type: 'turn_timeout', ms: 30000 }).message)
      .toBe('Execution aborted (cause=turn_timeout, ms=30000)');
    expect(makeExternalAbortError({ type: 'idle_timeout', ms: 5000 }).message)
      .toBe('Execution aborted (cause=idle_timeout, ms=5000)');
    expect(makeExternalAbortError({ type: 'user' }).message)
      .toBe('Execution aborted (cause=user)');
    expect(makeExternalAbortError().message).toBe('Execution aborted');
    // 非规范 reason 不进入 message / abortReason
    const odd = makeExternalAbortError('weird-string' as unknown);
    expect(odd.message).toBe('Execution aborted');
    expect(odd.abortReason).toBeUndefined();
  });

  it('abortReason 为 opaque evidence：原样承载、cause 传播', () => {
    const reason = { type: 'custom_domain_reason', extra: 42 };
    const err = new ExternalAbortError(reason);
    expect(err.abortReason).toBe(reason);
    expect(err.cause).toBe(reason);
    expect(err.message).toBe('Execution aborted (cause=custom_domain_reason)');
  });
});
