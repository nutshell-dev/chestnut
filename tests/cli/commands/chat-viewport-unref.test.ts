import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('chat-viewport setInterval unref invariant (phase 1171 α-1)', () => {
  it('all setInterval assignments in chat-viewport.ts have .unref() called on the same variable', async () => {
    const srcPath = resolve(__dirname, '../../../src/cli/commands/chat-viewport.ts');
    const src = await readFile(srcPath, 'utf-8');

    // Match variable assignments like: const x = setInterval(... or x = setInterval(...
    const matches = [...src.matchAll(/(?:const\s+)?(\w+)\s*=\s*setInterval\(/g)];
    expect(matches.length).toBeGreaterThan(0);

    for (const m of matches) {
      const varName = m[1];
      const unrefPattern = new RegExp(`${varName}\\.unref\\(\\)`);
      expect(unrefPattern.test(src)).toBe(true);
    }
  });
});
