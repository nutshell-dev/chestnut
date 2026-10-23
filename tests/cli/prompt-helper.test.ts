/**
 * Phase 1983 Step C — 共享 question helper：默认值只显示一次，空输入取默认值。
 */

import { describe, it, expect, vi } from 'vitest';
import type * as readline from 'readline';
import { question } from '../../src/cli/utils/prompt.js';

function makeRl(answer: string): { rl: readline.Interface; prompts: string[] } {
  const prompts: string[] = [];
  const rl = {
    question: vi.fn((prompt: string, cb: (a: string) => void) => {
      prompts.push(prompt);
      cb(answer);
    }),
  } as unknown as readline.Interface;
  return { rl, prompts };
}

describe('cli/utils/prompt question helper', () => {
  it('带默认值：prompt 形如 `Model [X]: `（默认值只出现一次）', async () => {
    const { rl, prompts } = makeRl('');
    const answer = await question(rl, 'Model', 'qwen3.8-max');
    expect(prompts).toEqual(['Model [qwen3.8-max]: ']);
    expect(answer).toBe('qwen3.8-max');
  });

  it('无默认值：prompt 形如 `Base URL: `', async () => {
    const { rl, prompts } = makeRl('https://example.com/v1');
    const answer = await question(rl, 'Base URL');
    expect(prompts).toEqual(['Base URL: ']);
    expect(answer).toBe('https://example.com/v1');
  });

  it('空输入返回默认值；非空输入去空白后返回', async () => {
    expect(await question(makeRl('   ').rl, 'Confirm?', 'N')).toBe('N');
    expect(await question(makeRl(' y ').rl, 'Confirm?', 'N')).toBe('y');
  });

  it('无默认值且空输入返回空串', async () => {
    expect(await question(makeRl('').rl, 'Model')).toBe('');
  });
});
