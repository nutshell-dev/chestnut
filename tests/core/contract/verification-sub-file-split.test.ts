import { describe, it, expect } from 'vitest';
import * as VerificationMain from '../../../src/core/contract/verification.js';
import * as fs from 'node:fs/promises';

const SUB_FILES = [
  'verification-format.ts',
  'verification-notify.ts',
  'verification-execution.ts',
  'verification-lifecycle.ts',
];

describe('phase 1237 contract/verification sub-file cluster DAG', () => {
  // 反向 1: 公开 API signature 不动
  it('public exports: 9 functions unchanged', () => {
    expect(typeof VerificationMain.runVerificationPipeline).toBe('function');
    expect(typeof VerificationMain.runVerificationInBackground).toBe('function');
    expect(typeof VerificationMain.archiveAndEmit).toBe('function');
    expect(typeof VerificationMain.completeSubtaskSync).toBe('function');
    expect(typeof VerificationMain.writeVerificationInbox).toBe('function');
    expect(typeof VerificationMain.writeVerificationError).toBe('function');
    expect(typeof VerificationMain.formatRejectionFeedback).toBe('function');
    expect(typeof VerificationMain.runScriptVerification).toBe('function');
    expect(typeof VerificationMain.runLLMVerification).toBe('function');
  });

  // 反向 2: cluster DAG / 无 cycle (per phase 1228 DAG 断言模板)
  it('4 sub-file cluster forms a DAG (no cycle / ML#5 严格判断)', async () => {
    const importMap = new Map<string, Set<string>>();
    for (const file of SUB_FILES) {
      const content = await fs.readFile(`src/core/contract/${file}`, 'utf-8');
      const imports = new Set<string>();
      for (const other of SUB_FILES) {
        if (other === file) continue;
        const otherBase = other.replace('.ts', '');
        if (new RegExp(`from ['"]\\./${otherBase}`).test(content)) {
          imports.add(other);
        }
      }
      importMap.set(file, imports);
    }

    function hasCycle(): boolean {
      const WHITE = 0, GRAY = 1, BLACK = 2;
      const color = new Map<string, number>();
      for (const f of SUB_FILES) color.set(f, WHITE);

      function dfs(node: string): boolean {
        color.set(node, GRAY);
        const deps = importMap.get(node) ?? new Set();
        for (const dep of deps) {
          if (color.get(dep) === GRAY) return true;
          if (color.get(dep) === WHITE && dfs(dep)) return true;
        }
        color.set(node, BLACK);
        return false;
      }

      for (const f of SUB_FILES) {
        if (color.get(f) === WHITE && dfs(f)) return true;
      }
      return false;
    }

    expect(hasCycle()).toBe(false);
  });

  // 反向 3: thin pipeline imports 4 sub-file
  it('verification.ts (thin pipeline) imports all 4 sub-file', async () => {
    const main = await fs.readFile('src/core/contract/verification.ts', 'utf-8');
    const expected = ['verification-format', 'verification-notify', 'verification-execution', 'verification-lifecycle'];
    for (const sub of expected) {
      expect(main).toMatch(new RegExp(`from ['"]\\./${sub}`));
    }
  });
});
