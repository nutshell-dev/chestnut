/**
 * Phase 1196 Step B: production caller ratchet for contract verification mutation.
 *
 * Ensures the verification mutation surface stays narrow after Step A:
 * - No production caller invokes the old public `completeSubtask` method.
 * - `runVerificationPipeline` is only called from `ContractSystem`'s internal
 *   submit callback (plus its own definition).
 * - `completeSubtaskSync` stays inside the verification pipeline cluster.
 * - Assembly registers the manager-owned tool, not a standalone factory.
 * - The standalone tool builder is not re-exported from the Contract barrel.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const srcRoot = path.join(repoRoot, 'src');
const contractSrc = path.join(srcRoot, 'core', 'contract');
const assemblySrc = path.join(srcRoot, 'assembly');
const contractIndex = path.join(contractSrc, 'index.ts');

describe('Phase 1196 verification mutation caller ratchet', () => {
  it('no production `.completeSubtask(` call sites remain', () => {
    const cmd = `grep -rnE "\\.completeSubtask\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });

  it('`runVerificationPipeline(` production callers are limited to definition + ContractSystem submit callback', () => {
    const cmd = `grep -rnE "runVerificationPipeline\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);
    // Definition in verification.ts + call in manager.ts submitSubtaskInternal.
    const allowed = [
      path.join('src', 'core', 'contract', 'verification.ts'),
      path.join('src', 'core', 'contract', 'manager.ts'),
    ].map(p => path.resolve(repoRoot, p));

    const offenders: string[] = [];
    for (const line of lines) {
      const filePath = path.resolve(repoRoot, line.split(':')[0]);
      if (!allowed.includes(filePath)) {
        offenders.push(line);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('`completeSubtaskSync(` production callers stay inside verification pipeline cluster', () => {
    const cmd = `grep -rnE "completeSubtaskSync\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);
    const allowed = [
      path.join('src', 'core', 'contract', 'verification.ts'),
      path.join('src', 'core', 'contract', 'verification-lifecycle.ts'),
    ].map(p => path.resolve(repoRoot, p));

    const offenders: string[] = [];
    for (const line of lines) {
      const filePath = path.resolve(repoRoot, line.split(':')[0]);
      if (!allowed.includes(filePath)) {
        offenders.push(line);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Assembly registers only `contractManager.createSubmitSubtaskTool()`', () => {
    const cmd = `grep -rnE "createSubmitSubtaskTool\\(" ${assemblySrc} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/contractManager\.createSubmitSubtaskTool\(\)/);
  });

  it('Contract barrel does not export the standalone submit tool builder', () => {
    const indexSrc = fs.readFileSync(contractIndex, 'utf8');
    expect(indexSrc).not.toMatch(/submit-subtask/);
  });
});
