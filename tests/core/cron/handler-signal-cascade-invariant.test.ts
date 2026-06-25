import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

/**
 * cron handler signal cascade invariant (phase 1266 r135 B fork)
 *
 * #1 NEW handler arrow without signal param ratchet 已迁 ESLint custom rule
 * `chestnut-custom/no-cron-handler-without-signal` (phase 423).
 *
 * 本 file 仅留 positive presence checks #2 + #3:
 *   #2 runXxx fn opts interface contains `signal?: AbortSignal`
 *   #3 dream-trigger handler wires signal
 */
describe('cron handler signal cascade positive checks (phase 423 缩 vitest)', () => {
  it('all cron jobs runXxx fn must accept signal in opts type', () => {
    // phase 697 Step A: cron 物理迁 src/core/cron/ → src/foundation/cron/
    const jobsDir = path.join(repoRoot, 'src', 'foundation', 'cron', 'jobs');
    const contractJobsDir = path.join(repoRoot, 'src', 'core', 'contract', 'jobs');

    const jobFiles = [
      ...(existsSync(jobsDir) ? readdirSync(jobsDir) : [])
        .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map(f => path.join(jobsDir, f)),
      ...readdirSync(contractJobsDir)
        .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map(f => path.join(contractJobsDir, f)),
    ];

    const violations: string[] = [];

    for (const filePath of jobFiles) {
      const src = readFileSync(filePath, 'utf-8');
      const fileName = path.basename(filePath);

      // Skip files that don't export a runXxx function or Options interface
      const hasRunFn = /export\s+(async\s+)?function\s+run\w+\s*\(/.test(src);
      if (!hasRunFn) continue;

      // Check that the Options interface contains signal?: AbortSignal
      if (!/signal\?\s*:\s*AbortSignal/.test(src)) {
        violations.push(fileName);
      }
    }

    expect(
      violations,
      `Missing signal?: AbortSignal in opts interface for: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('反向 3: dream-trigger cooperative invariant (already wire signal)', () => {
    const dreamTriggerPath = path.join(repoRoot, 'src', 'core', 'memory', 'jobs', 'dream-trigger.ts');
    const src = readFileSync(dreamTriggerPath, 'utf-8');

    // Dream-trigger must remain cooperative with async (signal) =>
    const dreamTriggerMatch = src.match(
      /handler:\s*async\s*\(\s*signal\s*\)\s*=>/,
    );
    expect(dreamTriggerMatch, 'dream-trigger handler must wire signal param').toBeTruthy();
  });
});
