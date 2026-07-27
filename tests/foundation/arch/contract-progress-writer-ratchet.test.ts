/**
 * Phase 1201 Step D/E: active progress writer ratchet.
 *
 * 单一职责：active progress 的物理写只在 owner，且 queued commit 必须
 * existing-parent（不 ensureDir、不 ghost-recreate）。
 * - `saveProgress(` 调用只在 manager.ts 与 persistence.ts；
 * - verification cluster 无 saveProgress 调用；
 * - manager 不调用 ensure-parent 通用 writeAtomic；
 * - writeAtomicExisting 实现体不含 ensureDir/mkdir。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RATCHET_PATHS,
  findSaveProgressCalls,
  findGenericWriteAtomicCalls,
  findEnsureParentInBody,
  extractFunctionBody,
  extractMethodBody,
} from '../../helpers/progress-authority-scanners.js';

const { repoRoot, srcRoot, contractSrc, managerFile, persistenceFile, nodeFsFile } = RATCHET_PATHS;

describe('Phase 1201: active progress writer ratchet', () => {
  it('规则 2：active progress writer（saveProgress 调用）只在 manager.ts 与 persistence.ts', () => {
    const cmd = `grep -rnE "saveProgress\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    const lines = out === '' ? [] : out.split('\n');
    const allowed = new Set([
      path.join('src', 'core', 'contract', 'manager.ts'),
      path.join('src', 'core', 'contract', 'persistence.ts'),
    ].map(p => path.resolve(repoRoot, p)));
    const offenders = lines.filter(line => !allowed.has(path.resolve(repoRoot, line.split(':')[0])));
    expect(offenders).toEqual([]);
  });

  it('规则 3：verification cluster 无 saveProgress 调用', () => {
    const clusterFiles = fs.readdirSync(contractSrc)
      .filter(f => /^verification.*\.ts$|^verifier-job\.ts$/.test(f));
    expect(clusterFiles.length).toBeGreaterThan(0);
    for (const f of clusterFiles) {
      const text = fs.readFileSync(path.join(contractSrc, f), 'utf8');
      expect(findSaveProgressCalls(text), `${f} must not call saveProgress`).toEqual([]);
    }
  });

  it('规则 3 反向 fixture：cluster 内注入 saveProgress 调用会被检出', () => {
    expect(findSaveProgressCalls('await this.saveProgress(id, progress);')).toHaveLength(1);
    // 注释提及（无括号调用形式）不误报。
    expect(findSaveProgressCalls('// 不再 raw saveProgress。')).toHaveLength(0);
  });

  it('规则 E1：manager 不调用通用 writeAtomic；active 保存走 writeAtomicExisting', () => {
    const managerText = fs.readFileSync(managerFile, 'utf8');
    expect(findGenericWriteAtomicCalls(managerText)).toEqual([]);
    const body = extractFunctionBody(fs.readFileSync(persistenceFile, 'utf8'), 'saveActiveProgressExisting');
    expect(body).not.toBeNull();
    expect(body!).toContain('writeAtomicExisting(');
    expect(findGenericWriteAtomicCalls(body!)).toEqual([]);
  });

  it('规则 E1 反向 fixture：active owner 注入通用 writeAtomic 调用会被检出', () => {
    expect(findGenericWriteAtomicCalls('await this.fs.writeAtomic(p, c);')).toHaveLength(1);
    expect(findGenericWriteAtomicCalls('await this.fs.writeAtomicExisting(p, c);')).toHaveLength(0);
  });

  it('规则 E2：writeAtomicExisting 实现体不含 ensureDir/mkdir', () => {
    const body = extractMethodBody(fs.readFileSync(nodeFsFile, 'utf8'), 'writeAtomicExisting');
    expect(body).not.toBeNull();
    expect(findEnsureParentInBody(body!)).toEqual([]);
  });

  it('规则 E2 反向 fixture：实现体注入 ensureDir 会被检出', () => {
    expect(findEnsureParentInBody('{\n  await ensureDir(dir);\n  await writeAtomic(abs, c);\n}')).toHaveLength(1);
    expect(findEnsureParentInBody('{\n  return wrapENOENT(p, () => writeAtomic(abs, c));\n}')).toHaveLength(0);
  });
});
