/**
 * Phase 1227 Step A: FileTool edit authority ratchet.
 *
 * FileTool edit no longer maintains per-(ctx, path) Promise-chain scheduling.
 * StepExecutor owns single-execution write ordering. This ratchet prevents the
 * queue from moving back into FileTool or being re-described as a global
 * lost-update prevention mechanism.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

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

describe('Phase 1227 Step A: FileTool edit authority ratchet', () => {
  it('FileTool source and tests contain no per-path edit queue primitives', () => {
    const roots = [
      path.join(srcRoot, 'foundation', 'file-tool'),
      path.join(testsRoot, 'foundation', 'file-tool'),
    ];
    const patterns = [
      'contextQueues',
      'function enqueue',
      'serialization queues',
      'per-\\(ctx',
      'per-path queue',
      'critical section',
    ];
    const offenders: string[] = [];
    for (const pattern of patterns) {
      offenders.push(...grep(pattern, roots));
    }
    expect(offenders.filter(line => fileOf(line) !== selfFile)).toEqual([]);
  });

  it('edit-commit.ts no longer exports or contains an enqueue helper', () => {
    const file = path.join(srcRoot, 'foundation', 'file-tool', 'edit-commit.ts');
    const text = execSync(`cat "${file}"`, { encoding: 'utf8' });
    expect(text).not.toContain('enqueue');
    expect(text).not.toContain('contextQueues');
    expect(text).not.toContain('Promise-chain');
  });
});
