/**
 * phase 1256 Step A fixture: Assembly guidance wiring envelope 化静态覆盖。
 *
 * 两处独立 closure（business-systems.ts / runtime-assembly.ts）必须同步改接
 * GuidanceEnvelope；任一仍使用旧 positional `(type, state)` signature 即 fail，
 * 防止「只改一处」回流（总览反向验收 #2）。
 *
 * Step A 中间态：两 closure 显式解包 envelope 调旧 registry（compose(input.type, input.meta)），
 * Step B 删除解包后本 fixture 同步改断言 pass-through 形态。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../../../src');

const WIRING_FILES = [
  'assembly/business-systems.ts',
  'assembly/runtime-assembly.ts',
];

describe('phase 1256 Step A: assembly guidance wiring envelope fixture', () => {
  for (const rel of WIRING_FILES) {
    const content = fs.readFileSync(path.join(srcDir, rel), 'utf-8');

    it(`${rel}: no positional (type, state) guidanceCompose signature remains`, () => {
      expect(content).not.toMatch(/guidanceCompose[^(]*\(\s*type\s*:\s*string/);
      expect(content).not.toMatch(/\(type:\s*string,\s*state:\s*Record<string,\s*string>\)/);
    });

    it(`${rel}: closure adapts envelope (Step A intermediate unpack)`, () => {
      expect(content).toMatch(/compose\(input\.type,\s*input\.meta\)/);
    });
  }
});
