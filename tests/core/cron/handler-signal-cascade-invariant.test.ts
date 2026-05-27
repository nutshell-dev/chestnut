import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

describe('cron handler signal cascade invariant (phase 1266 r135 B fork)', () => {
  it('all assemble.ts cron handler arrows must wire signal param', () => {
    const assemblePath = path.join(repoRoot, 'src', 'assembly', 'assemble.ts');
    const src = readFileSync(assemblePath, 'utf-8');

    // Find all handler: lines and check none use () => (no signal)
    // dream-trigger's async (signal) is acceptable
    const handlerLines = src.split('\n').filter(line => line.includes('handler:'));
    const violations: string[] = [];

    for (const line of handlerLines) {
      // Matches handler: () => or handler: async () => (no signal param)
      // Does NOT match handler: (signal) => or handler: async (signal) =>
      if (/handler:\s*(async\s*)?\(\s*\)\s*=>/.test(line)) {
        violations.push(line.trim());
      }
    }

    expect(
      violations,
      `Found ${violations.length} handler arrow(s) missing signal param in assemble.ts`,
    ).toEqual([]);
  });

  it('all cron jobs runXxx fn must accept signal in opts type', () => {
    const jobsDir = path.join(repoRoot, 'src', 'core', 'cron', 'jobs');
    const contractJobsDir = path.join(repoRoot, 'src', 'core', 'contract', 'jobs');

    const jobFiles = [
      ...readdirSync(jobsDir)
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
    const assemblePath = path.join(repoRoot, 'src', 'assembly', 'assemble.ts');
    const src = readFileSync(assemblePath, 'utf-8');

    // Dream-trigger must remain cooperative with async (signal) =>
    const dreamTriggerMatch = src.match(
      /handler:\s*async\s*\(\s*signal\s*\)\s*=>/,
    );
    expect(dreamTriggerMatch, 'dream-trigger handler must wire signal param').toBeTruthy();
  });
});
