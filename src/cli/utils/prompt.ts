/**
 * Phase 1983 Step C：start/init 与 provider add 共享的 question helper。
 * 叶子模块（仅依赖 readline 类型）；默认值只显示一次（`${prompt} [${defaultValue}]: `），
 * 空输入返回默认值。调用方传 `value || undefined`，避免空默认值显示成 `[]`。
 */

import type * as readline from 'readline';

export function question(
  rl: readline.Interface,
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const fullPrompt = defaultValue !== undefined
      ? `${prompt} [${defaultValue}]: `
      : `${prompt}: `;
    rl.question(fullPrompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}
