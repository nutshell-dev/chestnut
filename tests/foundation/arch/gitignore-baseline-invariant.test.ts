import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 622: invariant that .gitignore contains 6 baseline patterns
 * (each on its own line, exact-trim match):
 * - `node_modules`     — deps (100+ MB, never in repo)
 * - `dist/`            — build output (would create eternal-dirty state)
 * - `.chestnut/`       — runtime data (claw workspaces, agent state,
 *                        audit logs)
 * - `.env`             — secrets (must never enter version control)
 * - `coverage/`        — vitest --coverage output (transient)
 * - `.tsbuildinfo`     — TS incremental cache (drifts every build)
 *
 * Rationale: each missing entry has a distinct failure mode — repo bloat,
 * secret leak, eternal-dirty status, etc. The 6 are not optional
 * optimizations; they're security + hygiene baselines.
 *
 * Phase 622 doesn't lock the full .gitignore content (OS-specific lines
 * like .DS_Store, IDE lines like .vscode/ remain elastic). Only the 6
 * required baselines.
 *
 * Pairs with phase 621 (package identity), phase 612 (entry points).
 */
describe('.gitignore baseline patterns invariant (phase 622)', () => {
  it('contains 6 baseline patterns', () => {
    const gitignorePath = path.resolve(__dirname, '../../../.gitignore');
    const text = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = text.split('\n').map(l => l.trim());
    const REQUIRED = [
      'node_modules',
      'dist/',
      '.chestnut/',
      '.env',
      'coverage/',
      '.tsbuildinfo',
    ];
    const missing = REQUIRED.filter(pat => !lines.includes(pat));
    expect(missing).toEqual([]);
  });
});
