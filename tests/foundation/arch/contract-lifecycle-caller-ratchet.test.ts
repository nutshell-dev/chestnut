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

/**
 * Phase 1198 Step E: generic rename commit must be progress-blind.
 * The scanner extracts the `commitTerminalLifecycle` body and rejects any
 * progress read/write/delete. Patterns intentionally cover direct and
 * callback-mediated mutation spellings.
 */
const PROGRESS_MUTATION_PATTERNS: RegExp[] = [
  /\bsaveProgress\s*\(/,
  /\bwriteAtomic\w*\s*\([^)]*progress/i,
  /\bwrite(?:Exclusive|Sync)?\s*\([^)]*progress/i,
  /\b(?:delete|remove|rm)\w*\s*\([^)]*progress/i,
  /progress\.json/i,
];

function extractCommitBody(src: string): string {
  const marker = 'export async function commitTerminalLifecycle';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('commitTerminalLifecycle definition not found');
  const rest = src.slice(start);
  const next = rest.indexOf('\n/**');
  return next < 0 ? rest : rest.slice(0, next);
}

function findProgressMutationsInCommit(src: string): string[] {
  const body = extractCommitBody(src);
  return PROGRESS_MUTATION_PATTERNS.filter(p => p.test(body)).map(p => p.source);
}

/** A typed outcome is consumed by assignment, return, or passing as an argument. */
const VOID_SINK_LINE = /^(?:await\s+)?commitTerminalLifecycle\s*\(/;

function scanSinkLines(grepLines: string[]): string[] {
  return grepLines.filter(line => {
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    const code = line.slice(secondColon + 1).trim();
    return VOID_SINK_LINE.test(code);
  });
}

function findVoidOutcomeSinks(): string[] {
  const cmd = `grep -rnE "commitTerminalLifecycle\\(" ${srcRoot} --include='*.ts' || true`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  const lines = out.split('\n').filter(Boolean);
  return scanSinkLines(lines);
}

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
    // LifecycleContext no longer exposes saveProgress; lifecycle helpers must not call it.
    const callMatches = lifecycleSrc.match(/saveProgress\(/g);
    expect(callMatches ?? []).toEqual([]);
  });

  it('generic commit body is progress-blind (no progress write/delete/read)', () => {
    const lifecycleSrc = fs.readFileSync(lifecycleFile, 'utf8');
    expect(findProgressMutationsInCommit(lifecycleSrc)).toEqual([]);
  });

  it('reverse fixture: injected direct progress write/delete inside generic commit is detected', () => {
    const lifecycleSrc = fs.readFileSync(lifecycleFile, 'utf8');
    const anchor = 'await ctx.fs.ensureDir(targetContainer);';
    expect(lifecycleSrc).toContain(anchor);

    const withWrite = lifecycleSrc.replace(
      anchor,
      `${anchor}\n  await ctx.fs.writeAtomic(\`${'${sourceRoot}'}/progress.json\`, '{}');`,
    );
    expect(findProgressMutationsInCommit(withWrite)).not.toEqual([]);

    const withDelete = lifecycleSrc.replace(
      anchor,
      `${anchor}\n  await ctx.fs.delete(\`${'${sourceRoot}'}/progress.json\`);`,
    );
    expect(findProgressMutationsInCommit(withDelete)).not.toEqual([]);

    const withSaveProgress = lifecycleSrc.replace(
      anchor,
      `${anchor}\n  await ctx.saveProgress(contractId, {} as never);`,
    );
    expect(findProgressMutationsInCommit(withSaveProgress)).not.toEqual([]);
  });

  it('no production caller discards the typed outcome (void sink)', () => {
    expect(findVoidOutcomeSinks()).toEqual([]);
  });

  it('reverse fixture: a discarded typed outcome is flagged as void sink', () => {
    const sinkLines = [
      '/x/src/core/contract/manager.ts:100:    await commitTerminalLifecycle(ctx, id, intent);',
      '/x/src/core/contract/manager.ts:101:    commitTerminalLifecycle(ctx, id, intent);',
    ];
    expect(scanSinkLines(sinkLines)).toEqual(sinkLines);

    const consumedLines = [
      '/x/src/core/contract/manager.ts:100:    const outcome = await commitTerminalLifecycle(ctx, id, intent);',
      '/x/src/core/contract/manager.ts:101:    return commitTerminalLifecycle(ctx, id, intent);',
      '/x/src/core/contract/manager.ts:102:    return await commitTerminalLifecycle(ctx, id, intent);',
      '/x/src/core/contract/manager.ts:103:    outcomes.push(await commitTerminalLifecycle(ctx, id, intent));',
      '/x/src/core/contract/lifecycle.ts:126:export async function commitTerminalLifecycle(',
    ];
    expect(scanSinkLines(consumedLines)).toEqual([]);
  });

  it('raw `moveContractToArchive(` is not defined or called in production code', () => {
    const cmd = `grep -rnE "moveContractToArchive\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toEqual([]);
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
