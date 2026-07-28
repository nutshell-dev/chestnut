/**
 * Phase 1229 Step A: read-state commit authority ratchet.
 *
 * FileTool owns the overwrite-gate entry/schema and the persistence primitive.
 * Runtime owns the timing: one aggregated snapshot is persisted only after the
 * complete step's dialog snapshot has been saved. This ratchet prevents the
 * fire-and-forget per-mutation persist and its Promise-chain drain from
 * returning to FileTool, and prevents Runtime from constructing its own chain.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const repoRoot = path.resolve(__dirname, '../../..');
const srcRoot = path.join(repoRoot, 'src');
const testsRoot = path.join(repoRoot, 'tests');
const selfFile = path.resolve(__filename);

function grep(pattern: string, roots: string[]): string[] {
  const cmd = `grep -rnE "${pattern}" ${roots.join(' ')} --include='*.ts' || true`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  return out === '' ? [] : out.split('\n');
}

function fileOf(line: string): string {
  return path.resolve(repoRoot, line.split(':')[0]);
}

describe('Phase 1229 Step A: read-state commit authority ratchet', () => {
  it('FileTool source contains no fire-and-forget persist or per-ctx Promise-chain', () => {
    const roots = [path.join(srcRoot, 'foundation', 'file-tool')];
    const patterns = [
      'inflightPersist',
      'WeakMap<ExecContext, Promise<void>>',
      'persistReadFileState\\(ctx\\)\\.catch',
      'void persistReadFileState',
    ];
    const offenders: string[] = [];
    for (const pattern of patterns) {
      offenders.push(...grep(pattern, roots));
    }
    expect(offenders.filter(line => fileOf(line) !== selfFile)).toEqual([]);
  });

  it('file-state-manager.ts no longer imports or calls persistReadFileState', () => {
    const file = path.join(srcRoot, 'foundation', 'file-tool', 'file-state-manager.ts');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('persistReadFileState');
    expect(text).not.toContain('READ_FILE_STATE_PERSIST_FAILED');
  });

  it('Runtime does not introduce its own read-state Promise-chain', () => {
    const roots = [path.join(srcRoot, 'core', 'runtime')];
    const patterns = [
      'inflightPersist',
      'WeakMap<ExecContext, Promise<void>>',
      'new Promise.*readFileState',
    ];
    const offenders: string[] = [];
    for (const pattern of patterns) {
      offenders.push(...grep(pattern, roots));
    }
    expect(offenders.filter(line => fileOf(line) !== selfFile)).toEqual([]);
  });

  it('Runtime onStepComplete awaits persistReadFileState after dialog save', () => {
    const file = path.join(srcRoot, 'core', 'runtime', 'runtime.ts');
    const text = fs.readFileSync(file, 'utf8');
    const onStepComplete = text.match(/onStepComplete:[\s\S]{0,800}/);
    expect(onStepComplete).not.toBeNull();
    const snippet = onStepComplete![0];
    expect(snippet).toMatch(/await this\.sessionManager\.save\(/);
    expect(snippet).toMatch(/await persistReadFileState\(this\.execContext\)/);
    const saveIndex = snippet.indexOf('await this.sessionManager.save(');
    const persistIndex = snippet.indexOf('await persistReadFileState(this.execContext)');
    expect(saveIndex).toBeLessThan(persistIndex);
  });
});
