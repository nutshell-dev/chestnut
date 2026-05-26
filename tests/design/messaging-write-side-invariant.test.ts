import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, '../../src');

describe('phase 1333 messaging write-side mechanical invariant N=10 累达', () => {
  const BAN_PATTERNS = [
    String.raw`fs\.writeAtomic\([^)]*inbox`,
  ];
  const SCAN_DIRS = [
    'src/core/cron/',
    'src/watchdog/',
    'src/core/memory/',
    'src/core/contract/',
    'src/core/runtime/',
  ];
  const ALLOWLIST = ['src/foundation/messaging/inbox-writer.ts'];

  for (const pattern of BAN_PATTERNS) {
    for (const dir of SCAN_DIRS) {
      it(`grep -rnE '${pattern}' ${dir} 应 0 hit (excluding ALLOWLIST)`, () => {
        let out = '';
        try {
          out = execSync(
            `grep -rnE '${pattern}' ${path.join(SRC_ROOT, '..', dir)} --include='*.ts' || true`,
            { encoding: 'utf-8' },
          ).trim();
        } catch (err: any) {
          // exit 1 ok
        }
        const filtered = out
          .split('\n')
          .filter(line => line && !ALLOWLIST.some(a => line.includes(a)));
        expect(
          filtered,
          `Forbidden raw fs.writeAtomic to inbox in ${dir}:\n${filtered.join('\n')}`,
        ).toEqual([]);
      });
    }
  }
});
