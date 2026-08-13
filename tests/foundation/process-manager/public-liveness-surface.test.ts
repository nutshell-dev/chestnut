/**
 * Phase 1382: ProcessManager exposes one directory-liveness query.
 *
 * `getAliveStatus()` is the canonical query. Boolean consumers project its
 * `alive` field; the owner must not grow a second wrapper or context seam.
 * L1 process-exec PID liveness and UI state named `isAlive` are out of scope.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const PROCESS_MANAGER_ROOT = path.join(SRC_ROOT, 'foundation', 'process-manager');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function walkTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(target);
    return entry.name.endsWith('.ts') ? [target] : [];
  });
}

describe('ProcessManager public liveness surface (phase 1382)', () => {
  it('keeps getAliveStatus as the only owner directory-liveness query', () => {
    const manager = read('src/foundation/process-manager/manager.ts');
    const alive = read('src/foundation/process-manager/alive.ts');
    const types = read('src/foundation/process-manager/types.ts');

    expect(manager).toMatch(/\bgetAliveStatus\s*\(daemonDir:\s*DaemonDir\)/);
    expect(alive).toMatch(/export function getAliveStatus\s*\(/);

    expect(manager).not.toMatch(/^\s*isAlive\s*\(daemonDir:\s*DaemonDir\)/m);
    expect(alive).not.toMatch(/export function isAliveByPidFile\s*\(/);
    expect(types).not.toMatch(/^\s*isAlive\?:\s*\(daemonDir:\s*DaemonDir\)/m);
  });

  it('production callers do not consume a ProcessManager isAlive wrapper', () => {
    const violations = walkTs(SRC_ROOT)
      .filter((file) => !file.startsWith(`${PROCESS_MANAGER_ROOT}${path.sep}`))
      .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const usesDirectoryWrapper = /\.isAlive\s*\(\s*resolveClawDaemonDir\s*\(/.test(source);
        const narrowsToWrapper = /Pick<ProcessManager,\s*['"]isAlive['"]/.test(source);
        return usesDirectoryWrapper || narrowsToWrapper
          ? [path.relative(PROJECT_ROOT, file)]
          : [];
      });

    expect(violations).toEqual([]);
  });

  it('scanner rejects old wrapper forms without matching L1 PID probes or view state', () => {
    expect('.isAlive(resolveClawDaemonDir(makeClawId(name)))').toMatch(
      /\.isAlive\s*\(\s*resolveClawDaemonDir\s*\(/,
    );
    expect("type PM = Pick<ProcessManager, 'isAlive' | 'spawn'>").toMatch(
      /Pick<ProcessManager,\s*['"]isAlive['"]/,
    );
    expect('isAlive(pid)').not.toMatch(/\.isAlive\s*\(\s*resolveClawDaemonDir\s*\(/);
    expect('isAlive: boolean').not.toMatch(/\.isAlive\s*\(\s*resolveClawDaemonDir\s*\(/);
  });
});
