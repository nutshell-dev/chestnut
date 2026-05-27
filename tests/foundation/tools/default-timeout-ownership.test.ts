import { describe, it, expect } from 'vitest';
import { DEFAULT_TOOL_TIMEOUT_MS, createToolExecutor } from '../../../src/foundation/tools/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('phase 1027: DEFAULT_TOOL_TIMEOUT_MS L2 唯一 ownership', () => {
  it('exported from L2 foundation/tools (反向 1: L2 唯一 source)', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(3_600_000);
  });

  it('ToolExecutor ctor default uses imported const (反向 2: 同模块单源)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/foundation/tools/executor.ts'),
      'utf8'
    );
    expect(src).toMatch(/defaultTimeoutMs\s*=\s*DEFAULT_TOOL_TIMEOUT_MS/);
    expect(src).not.toMatch(/defaultTimeoutMs\s*=\s*60000/);
  });

  it('L5 runtime/constants.ts 已删除 (反向 3: phase 1301 删空壳 / L5 不再持)', () => {
    const exists = fs.existsSync(
      path.resolve(__dirname, '../../../src/core/runtime/constants.ts'),
    );
    expect(exists).toBe(false);
  });
});
