/**
 * Phase 1382: ProcessManager exposes one directory-liveness query.
 *
 * `liveness()` is the canonical typed query; `isAlive()` is its single-line
 * boolean projection. The owner must not grow a second wrapper or context seam.
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

describe('ProcessManager public liveness surface (phase 1382, ratchet phase 1773)', () => {
  it('keeps liveness() as the only owner directory-liveness query', () => {
    const manager = read('src/foundation/process-manager/manager.ts');
    const alive = read('src/foundation/process-manager/alive.ts');
    const types = read('src/foundation/process-manager/types.ts');

    // phase 1773: typed owner 是 liveness()，返回 LivenessResult union
    expect(manager).toMatch(/\bliveness\s*\(daemonDir:\s*DaemonDir\):\s*LivenessResult/);
    expect(alive).toMatch(/export function liveness\s*\(/);
    expect(types).toMatch(/export type LivenessResult\s*=/);

    // boolean convenience 只允许单行 fail-closed 投影，不得二次 probe
    expect(manager).toMatch(
      /isAlive\(daemonDir:\s*DaemonDir\):\s*boolean \{ return this\.liveness\(daemonDir\)\.kind === 'alive'; \}/,
    );

    // isAlive 已由上方正断言限定为单行投影；此处只禁旧 wrapper 形态
    expect(alive).not.toMatch(/export function isAliveByPidFile\s*\(/);
    expect(types).not.toMatch(/^\s*isAlive\?:\s*\(daemonDir:\s*DaemonDir\)/m);
  });

  // phase 1773: boolean convenience 是 sanctioned 单行投影；本 ratchet 改为「barrel 唯一门」——
  // 生产 caller 不得 deep import owner 模块（process-manager/alive.js 等）绕开 barrel 表面
  it('production callers reach liveness only through the process-manager barrel', () => {
    const violations = walkTs(SRC_ROOT)
      .filter((file) => !file.startsWith(`${PROCESS_MANAGER_ROOT}${path.sep}`))
      .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const deepOwnerImport = /from\s+['"][^'"]*process-manager\/(alive|generation|ready|stop|spawn)\.js['"]/.test(source);
        return deepOwnerImport ? [path.relative(PROJECT_ROOT, file)] : [];
      });

    expect(violations).toEqual([]);
  });

  it('scanner rejects deep owner imports and matches barrel-only consumption', () => {
    expect("import { describeLiveness } from '../foundation/process-manager/alive.js';").toMatch(
      /from\s+['"][^'"]*process-manager\/(alive|generation|ready|stop|spawn)\.js['"]/,
    );
    expect("import { describeLiveness } from '../foundation/process-manager/index.js';").not.toMatch(
      /from\s+['"][^'"]*process-manager\/(alive|generation|ready|stop|spawn)\.js['"]/,
    );
    expect("import { liveness } from './alive.js';").not.toMatch(
      /from\s+['"][^'"]*process-manager\/(alive|generation|ready|stop|spawn)\.js['"]/,
    );
  });
});
