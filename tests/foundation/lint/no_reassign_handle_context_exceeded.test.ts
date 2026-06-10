import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('handleContextExceeded reassign invariant (phase 224)', () => {
  it('src/ 内 0 处 `= handleContextExceeded(` 字面（除 exceeded.ts return）', () => {
    const SRC_ROOT = path.resolve(__dirname, '../../../src');

    // allow-list：helper 自身的 return / 类型字面
    const ALLOW: ReadonlyArray<string> = [
      'core/l4_context_manager/exceeded.ts',
    ];

    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const rel = path.relative(SRC_ROOT, full);
          if (ALLOW.includes(rel)) continue;
          const content = fs.readFileSync(full, 'utf-8');
          // 检 `messages = handleContextExceeded(` 危险模式（caller 用自身 persist messages 变量接收 trim 结果）
          if (/\bmessages\s*=\s*handleContextExceeded\s*\(/.test(content)) {
            hits.push(rel);
          }
        }
      }
    };

    walk(SRC_ROOT);
    expect(hits).toEqual([], `caller 用 'x = handleContextExceeded(...)' 切断 persist messages 引用、应改为 'const callView = handleContextExceeded(...)' + 用 callView.messages 构造 LLMCallOptions、append 仍走 caller 原 messages 引用。命中: ${hits.join(', ')}`);
  });
});
