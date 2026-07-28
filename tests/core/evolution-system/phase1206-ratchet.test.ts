/**
 * Phase 1206 Step D architecture ratchet.
 *
 * Forbids legacy retrospective write/read surfaces outside the explicitly
 * allowed migration boundaries.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve(process.cwd());
const SRC = path.join(ROOT, 'src');

/**
 * Run grep recursively and return matching lines as "file:line:match".
 * Returns empty string when there are no matches.
 */
function grepRecurse(args: string[]): string {
  try {
    return execFileSync('grep', ['-R', '-n', '--include=*.ts', '--include=*.js', ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
  } catch (e) {
    // grep exits 1 when no matches — treat as empty
    if ((e as any)?.status === 1) return '';
    throw e;
  }
}

function relativeFileFromHit(line: string): string {
  return line.split(':')[0] ?? '';
}

describe('phase1206 architecture ratchet', () => {
  it('forbids new writes to legacy clawspace/pending-retrospective/by-contract outside migration boundaries', () => {
    const hits = grepRecurse([
      'clawspace/pending-retrospective/by-contract',
      'src',
    ]);

    const allowedFiles = new Set([
      'src/core/summon-system/index.ts',
      'src/core/summon-system/post-processors/contract-extract.ts',
    ]);

    const violations = hits
      .split('\n')
      .map(relativeFileFromHit)
      .filter(Boolean)
      .filter(file => !allowedFiles.has(file));

    expect(violations).toEqual([]);
  });

  it('forbids legacy readPendingRetrospective/listPendingRetrospectives imports inside evolution-system', () => {
    const hits = grepRecurse([
      '-E',
      '(readPendingRetrospective|listPendingRetrospectives)',
      'src/core/evolution-system',
    ]);

    expect(hits.trim()).toBe('');
  });

  it('forbids runRetroForContract references outside evolution-system/system.ts', () => {
    const hits = grepRecurse([
      'runRetroForContract',
      'src',
    ]);

    const allowedFile = 'src/core/evolution-system/system.ts';

    const violations = hits
      .split('\n')
      .map(relativeFileFromHit)
      .filter(Boolean)
      .filter(file => file !== allowedFile);

    expect(violations).toEqual([]);
  });

  it('forbids legacy retrospective concepts in production code', () => {
    const hits = grepRecurse([
      '-E',
      '(retroChain|lastProcessedAt|RETRO_CHAIN_STALL|skipped_duplicate)',
      'src',
    ]);

    expect(hits.trim()).toBe('');
  });

  it('synthetic violation: scanner catches a forbidden string injected into a temp file', () => {
    const tmpDir = path.join(ROOT, 'src', '.ratchet-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'synthetic-violation.ts');
    fs.writeFileSync(tmpFile, '// clawspace/pending-retrospective/by-contract/synthetic.json\n');

    try {
      const hits = grepRecurse([
        'clawspace/pending-retrospective/by-contract',
        'src/.ratchet-tmp',
      ]);

      expect(hits.trim()).not.toBe('');
      expect(hits).toContain('synthetic-violation.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
