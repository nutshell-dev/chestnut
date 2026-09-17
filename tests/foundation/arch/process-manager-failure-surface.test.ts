/**
 * phase 1852 Step B: ProcessManager barrel 的最小失败协议表面锁。
 *
 * 正向：barrel 开放 ProcessGenerationStateError / ProcessWinnerConvergenceError
 * （identity === types.js owner 类，字段断言重放）与 type ProcessWinnerConvergenceReason /
 * EnsureRunningOutcome（fixture 编译锁，证明 owner/barrel 同源）。
 * 反向：src 内跨模块不得 deep import process-manager/types.js（绕过 barrel 表面）。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  ProcessGenerationStateError as OwnerGenerationStateError,
  ProcessWinnerConvergenceError as OwnerWinnerConvergenceError,
  makeDaemonDir,
} from '../../../src/foundation/process-manager/types.js';
import {
  ProcessGenerationStateError,
  ProcessWinnerConvergenceError,
} from '../../../src/foundation/process-manager/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_ROOT = path.join(repoRoot, 'src');
const PROCESS_MANAGER_ROOT = path.join(SRC_ROOT, 'foundation', 'process-manager');
const fixturePath = path.join(
  repoRoot,
  'tests/foundation/arch/fixtures/process-manager-failure-protocol-surface.ts',
);

function walkTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(target);
    return entry.name.endsWith('.ts') ? [target] : [];
  });
}

describe('ProcessManager failure protocol surface (phase 1852 Step B)', () => {
  it('binds the public generation-state error to the types owner with its facts', () => {
    const daemonDir = makeDaemonDir('/tmp/chestnut-daemon');
    const cause = new Error('invalid generation json');
    const error = new ProcessGenerationStateError(daemonDir, 'spawning', 'inspect', cause);

    expect(ProcessGenerationStateError).toBe(OwnerGenerationStateError);
    expect(error).toBeInstanceOf(OwnerGenerationStateError);
    expect(error.daemonDir).toBe(daemonDir);
    expect(error.location).toBe('spawning');
    expect(error.operation).toBe('inspect');
    expect(error.cause).toBe(cause);
  });

  it('binds the public winner-convergence error to the types owner with its facts', () => {
    const daemonDir = makeDaemonDir('/tmp/chestnut-daemon');
    const error = new ProcessWinnerConvergenceError(
      daemonDir,
      'winner_failed',
      'generation-1',
      'winner failed before ready',
    );

    expect(ProcessWinnerConvergenceError).toBe(OwnerWinnerConvergenceError);
    expect(error).toBeInstanceOf(OwnerWinnerConvergenceError);
    expect(error.daemonDir).toBe(daemonDir);
    expect(error.reason).toBe('winner_failed');
    expect(error.generationId).toBe('generation-1');
  });

  it('compiles the failure protocol types through the barrel', () => {
    const config = ts.readConfigFile(path.join(repoRoot, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
    const program = ts.createProgram({
      rootNames: [fixturePath],
      options: { ...parsed.options, noEmit: true, rootDir: undefined },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    expect(
      diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      })),
    ).toEqual([]);
  });

  it('forbids cross-module deep imports of process-manager/types.js in src', () => {
    const violations = walkTs(SRC_ROOT)
      .filter((file) => !file.startsWith(`${PROCESS_MANAGER_ROOT}${path.sep}`))
      .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const deepOwnerImport = /from\s+['"][^'"]*process-manager\/types\.js['"]/.test(source);
        return deepOwnerImport ? [path.relative(repoRoot, file)] : [];
      });

    expect(violations).toEqual([]);
  });
});
