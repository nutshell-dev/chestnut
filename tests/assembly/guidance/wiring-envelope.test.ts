/**
 * phase 1256 Step A/B fixture: Assembly guidance wiring envelope 化静态覆盖。
 *
 * 两处独立 closure（business-systems.ts / runtime-assembly.ts）必须同步改接
 * GuidanceEnvelope；任一仍使用旧 positional `(type, state)` signature 即 fail，
 * 防止「只改一处」回流（总览反向验收 #2）。
 *
 * Step B 终态：两 closure envelope 原样 pass-through 调 registry（compose(input)），
 * Step A 中间解包（compose(input.type, input.meta)）已删除、禁回流。
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

describe('phase 1256: assembly guidance wiring envelope fixture', () => {
  for (const rel of WIRING_FILES) {
    const content = fs.readFileSync(path.join(srcDir, rel), 'utf-8');

    it(`${rel}: no positional (type, state) guidanceCompose signature remains`, () => {
      expect(content).not.toMatch(/guidanceCompose[^(]*\(\s*type\s*:\s*string/);
      expect(content).not.toMatch(/\(type:\s*string,\s*state:\s*Record<string,\s*string>\)/);
    });

    it(`${rel}: closure passes envelope through to registry (Step B final form)`, () => {
      expect(content).toMatch(/\.compose\(input\)/);
      // Step A 中间解包禁回流
      expect(content).not.toMatch(/compose\(input\.type,\s*input\.meta\)/);
    });
  }
});
