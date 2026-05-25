import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Grep-based parity invariant (mirror phase 964/1019/1199/1238/1244 template)
 * Ensures both formatter paths reference the same guard audit constants.
 */
describe('formatter parity invariant (phase 1274)', () => {
  it('双路径必须各引用 TOOL_RESULT_MISSING_ID + TOOL_RESULT_ORPHAN_ID', () => {
    const root = path.resolve('src');
    const anth = fs.readFileSync(path.join(root, 'foundation', 'llm-provider', 'base-anthropic.ts'), 'utf8');
    const oai = fs.readFileSync(path.join(root, 'foundation', 'llm-provider', 'openai-message-formatter.ts'), 'utf8');

    for (const k of ['TOOL_RESULT_MISSING_ID', 'TOOL_RESULT_ORPHAN_ID']) {
      expect(anth).toMatch(new RegExp(k));
      expect(oai).toMatch(new RegExp(k));
    }
  });

  it('base-anthropic 路径必须有 ASSISTANT_EMPTY_CONTENT_SKIPPED 守卫', () => {
    const root = path.resolve('src');
    const anth = fs.readFileSync(path.join(root, 'foundation', 'llm-provider', 'base-anthropic.ts'), 'utf8');
    expect(anth).toMatch(/ASSISTANT_EMPTY_CONTENT_SKIPPED/);
  });
});
