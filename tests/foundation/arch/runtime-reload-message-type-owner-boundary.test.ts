import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Runtime reload message type owner boundary (phase 1503)', () => {
  it('defines the reload message type in the Runtime inbox protocol owner', () => {
    expect(read('src/core/runtime/inbox-message-types.ts')).toMatch(
      /export const RELOAD_LLM_CONFIG_MESSAGE_TYPE = 'reload_llm_config' as const;/,
    );
  });

  it('Runtime implementation imports the reload message type directly from its owner', () => {
    expect(read('src/core/runtime/runtime.ts')).toMatch(
      // phase 1872 Step F 随改：import 成员列表可为多行（1869 Step G 起 runtime.ts 同行
      // 多常量 import）——断言口径 = 从 owner 直引该常量（不经 barrel/其他模块）。
      /import \{[^}]*RELOAD_LLM_CONFIG_MESSAGE_TYPE[^}]*\} from '\.\/inbox-message-types\.js';/,
    );
  });

  it('Runtime barrel exports the reload message type directly from its owner', () => {
    expect(read('src/core/runtime/index.ts')).toMatch(
      /export \{ RELOAD_LLM_CONFIG_MESSAGE_TYPE \} from '\.\/inbox-message-types\.js';/,
    );
  });

  it('Runtime audit events do not forward the inbox protocol constant', () => {
    expect(read('src/core/runtime/runtime-audit-events.ts')).not.toContain('RELOAD_LLM_CONFIG_MESSAGE_TYPE');
  });
});
