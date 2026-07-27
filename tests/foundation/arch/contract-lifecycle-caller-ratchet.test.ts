/**
 * Phase 1198 Step D: production caller ratchet for terminal lifecycle mutation.
 *
 * Ensures terminal lifecycle commits stay intent-first and rename-only:
 * - The generic `commitTerminalLifecycle` helper is the only path that performs
 *   a terminal active->archive directory rename.
 * - `cancelContract` and `markCorrupted` never call `saveProgress` before rename.
 * - Raw `moveContractToArchive` is not invoked from production callers.
 * - Direct `fs.move` calls in the contract module are limited to known helpers.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const srcRoot = path.join(repoRoot, 'src');
const contractSrc = path.join(srcRoot, 'core', 'contract');
const lifecycleFile = path.join(contractSrc, 'lifecycle.ts');

describe('Phase 1198 Step D: terminal lifecycle caller ratchet', () => {
  it('`commitTerminalLifecycle(` production callers are limited to lifecycle helpers', () => {
    const cmd = `grep -rnE "commitTerminalLifecycle\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);

    const allowed = [
      path.join('src', 'core', 'contract', 'lifecycle.ts'),
      path.join('src', 'core', 'contract', 'manager.ts'),
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

  it('`cancelContract` and `markCorrupted` never call `saveProgress` before rename', () => {
    const lifecycleSrc = fs.readFileSync(lifecycleFile, 'utf8');
    // saveProgress appears only in the LifecycleContext interface, never as a call.
    const callMatches = lifecycleSrc.match(/saveProgress\(/g);
    expect(callMatches ?? []).toEqual([]);
  });

  it('raw `moveContractToArchive(` has no production callers', () => {
    const cmd = `grep -rnE "moveContractToArchive\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    const lines = out.split('\n').filter(Boolean);
    // Only the function definition in lifecycle.ts is allowed.
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/src\/core\/contract\/lifecycle\.ts:/);
  });

  it('direct `fs.move` calls in contract module are limited to known helpers', () => {
    const cmd = `grep -rnE "\\.move\\(" ${contractSrc} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);

    const allowed = [
      path.join('src', 'core', 'contract', 'lifecycle.ts'),
      path.join('src', 'core', 'contract', '_isolation-helper.ts'),
      path.join('src', 'core', 'contract', 'jobs', 'archive-legacy-migrator.ts'),
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
});
