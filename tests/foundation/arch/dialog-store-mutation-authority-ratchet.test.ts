/**
 * Phase 1218 Step B: DialogStore mutation authority ratchet.
 *
 * 目标：在删除底层 Promise-chain 前，守住每类 DialogStore 实例的唯一 mutation authority。
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const srcRoot = path.join(repoRoot, 'src');
const testsRoot = path.join(repoRoot, 'tests');
const selfFile = path.resolve(__filename);

/**
 * Run grep and return non-empty lines.
 */
function grep(pattern: string, root: string): string[] {
  const cmd = `grep -rnE "${pattern}" ${root} --include='*.ts' || true`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  return out === '' ? [] : out.split('\n');
}

/**
 * Extract file path from a grep line like "src/foo.ts:123: ..."
 */
function fileOf(line: string): string {
  return path.resolve(repoRoot, line.split(':')[0]);
}

describe('Phase 1218 Step B: DialogStore mutation authority ratchet', () => {
  it('getFlushPromise 已从 src 与 tests 中移除（Phase 1218 Step C）', () => {
    const lines = grep('getFlushPromise', `${srcRoot} ${testsRoot}`);
    const allowed = new Set<string>([
      selfFile,
    ]);
    const offenders = lines.filter(line => !allowed.has(fileOf(line)));
    expect(offenders).toEqual([]);
  });

  it('production 中禁止 void dialogStore.save / void sessionManager.save / void messageStore.save 等 fire-and-forget', () => {
    const patterns = [
      'void\\s+\\w*Store\\.save\\(',
      'void\\s+sessionManager\\.save\\(',
      'void\\s+messageStore\\.save\\(',
      'void\\s+\\w*Store\\.archive\\(',
      'void\\s+sessionManager\\.archive\\(',
      'void\\s+messageStore\\.archive\\(',
    ];
    const offenders: string[] = [];
    for (const p of patterns) {
      const lines = grep(p, srcRoot);
      offenders.push(...lines);
    }
    expect(offenders).toEqual([]);
  });

  it('production DialogStore mutation caller 限制在 Runtime、ContextManager helper、SubAgent、DialogStore 内部 helper', () => {
    // Match method calls on DialogStore-like variables. We intentionally include
    // beginTurn/commitTurn/rollbackTurn because they are part of turn transaction
    // mutation surface.
    const lines = grep('\\.(save|archive|beginTurn|commitTurn|rollbackTurn)\\(', srcRoot);

    // Non-DialogStore .save() calls that happen to match the broad regex.
    const nonDialogStore = [
      'shortIdIndex.save',
      'blockIdIndex.save',
      'DialogStore.save',       // JSDoc references
      'DialogStore.archive',
    ];
    const mutationLines = lines.filter(line => {
      const text = line.split(':').slice(2).join(':');
      return !nonDialogStore.some(pattern => text.includes(pattern));
    });

    const allowedFiles = new Set<string>([
      path.join(srcRoot, 'core', 'runtime', 'runtime.ts'),
      path.join(srcRoot, 'core', 'context_manager', 'trim-and-persist.ts'),
      path.join(srcRoot, 'core', 'subagent', 'agent.ts'),
      path.join(srcRoot, 'core', 'event-loop', 'execution-recovery.ts'),
      path.join(srcRoot, 'foundation', 'dialog-store', 'regime-switch.ts'),
      path.join(srcRoot, 'foundation', 'dialog-store', 'store.ts'),
      selfFile,
    ]);

    const offenders = mutationLines.filter(line => !allowedFiles.has(fileOf(line)));
    expect(offenders).toEqual([]);
  });

  it('SubAgent 的 step 与 finally save 必须 await（禁止 fire-and-forget）', () => {
    const agentFile = path.join(srcRoot, 'core', 'subagent', 'agent.ts');
    const text = execSync(`cat "${agentFile}"`, { encoding: 'utf8' });

    // Find occurrences of messageStore.save and ensure each is awaited.
    const lines = text.split('\n');
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('this.messageStore.save(')) continue;
      const trimmed = line.trim();
      if (!trimmed.startsWith('await ')) {
        offenders.push(`${agentFile}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
