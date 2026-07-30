/**
 * Phase 1242 Step B: production import direction ratchet for AuditLog ↔ Cron.
 *
 * Goal: after Step A + Step B, the two modules have zero direct production imports
 * between each other. Assembly is allowed to import both (it is the composition point).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const auditSrc = path.join(repoRoot, 'src', 'foundation', 'audit');
const cronSrc = path.join(repoRoot, 'src', 'foundation', 'cron');

const AUDIT_TO_CRON_RE = /^\s*import\s+.*\s+from\s+['"][^'"]*cron\/[^'"]*['"]/gm;
const CRON_TO_AUDIT_RE = /^\s*import\s+.*\s+from\s+['"][^'"]*audit\/[^'"]*['"]/gm;

function scanDir(dir: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          matches.push(`${full}:${i + 1}:${lines[i].trim()}`);
        }
      }
    }
  }
  walk(dir);
  return matches;
}

function scanContent(content: string, pattern: RegExp): string[] {
  const lines = content.split('\n');
  const matches: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) matches.push(`${i + 1}:${lines[i].trim()}`);
  }
  return matches;
}

describe('AuditLog ↔ Cron no direct production import ratchet (phase 1242 Step B)', () => {
  it('src/foundation/audit contains 0 imports of src/foundation/cron', () => {
    expect(scanDir(auditSrc, AUDIT_TO_CRON_RE)).toEqual([]);
  });

  it('reverse fixture: AuditLog file importing Cron is detected', () => {
    const fixture = `// comment
import type { CronJob } from '../cron/index.js';
export const x = 1;`;
    const hits = scanContent(fixture, AUDIT_TO_CRON_RE);
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("import type { CronJob } from '../cron/index.js';");
  });

  it('src/foundation/cron contains 0 imports of src/foundation/audit', () => {
    expect(scanDir(cronSrc, CRON_TO_AUDIT_RE)).toEqual([]);
  });

  it('reverse fixture: Cron file importing AuditLog is detected', () => {
    const fixture = `import type { AuditLog } from '../../foundation/audit/index.js';
export function f(a: AuditLog) {}`;
    const hits = scanContent(fixture, CRON_TO_AUDIT_RE);
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("import type { AuditLog } from '../../foundation/audit/index.js';");
  });
});
