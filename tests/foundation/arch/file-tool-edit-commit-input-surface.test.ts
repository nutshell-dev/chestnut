import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editCommitSource = readFileSync(
  new URL('../../../src/foundation/file-tool/edit-commit.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool EditCommitInput deep surface', () => {
  it('keeps the input interface local behind editCommit', () => {
    expect(editCommitSource).not.toMatch(/export\s+interface\s+EditCommitInput\s*\{/);
    // phase 1817: 输入新增 guardedWrite（GuardedWrite capability 绑定 canonical
    // target，字段间有 doc comment）——字段集合锚定保留、字段间允许注释
    expect(editCommitSource).toMatch(
      /(?:^|\n)interface\s+EditCommitInput\s*\{(?:(?!\n\})[\s\S])*?\bctx:\s*ExecContext;(?:(?!\n\})[\s\S])*?\btool:\s*EditCommitTool;(?:(?!\n\})[\s\S])*?\bpath:\s*string;(?:(?!\n\})[\s\S])*?\bresolved:\s*string;(?:(?!\n\})[\s\S])*?\bguardedWrite:\s*GuardedWrite;(?:(?!\n\})[\s\S])*?\boriginal:\s*string;(?:(?!\n\})[\s\S])*?\bcandidate:\s*string;(?:(?!\n\})[\s\S])*?\bbackupSource:\s*EditCommitBackupSource;(?:(?!\n\})[\s\S])*?\breplaced:\s*number;(?:(?!\n\})[\s\S])*?\beditCount:\s*number;\s*\}/,
    );
    expect(editCommitSource).toMatch(/(?:^|\n)\s*input:\s*EditCommitInput,/);
    expect(barrelSource).not.toMatch(/\bEditCommitInput\b/);
  });
});
