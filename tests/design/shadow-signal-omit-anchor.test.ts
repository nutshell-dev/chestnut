/**
 * shadow signal omit anchor comment invariant (phase 1373 sub-4)
 * mechanical lint: verify spawn-shadow-subagent.ts contains the anchor comment.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(__dirname, '../../src/core/shadow-system/spawn-shadow-subagent.ts');

describe('shadow signal omit anchor lint (phase 1373 sub-4)', () => {
  it('spawn-shadow-subagent.ts 应包含 phase 1373 anchor comment', () => {
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('phase 1373 anchor: shadow-mode subagent 不继承 caller signal by-design');
  });
});
