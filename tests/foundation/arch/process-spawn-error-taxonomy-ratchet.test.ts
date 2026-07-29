/**
 * Phase 1235 ratchet: ProcessManager spawn 错误 taxonomy 已分型为
 * ProcessSpawnConflictError（合法竞争：active_owner | spawn_in_progress | commit_lost）
 * 与 ProcessGenerationStateError（malformed generation state）。旧 lock 语义
 * （LockConflictError / lockPath / lock_conflict outcome）不得回流
 * ProcessManager 与 Watchdog production scope。
 *
 * scope 不含 src/assembly/ —— Assembly 死转导（LockConflictError 自 host +
 * ASSEMBLE_LOCK_CONFLICT 常量/routing）按计划保留至下一 phase 清退，不可误报。
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const FORBIDDEN_RE = 'LockConflictError|lockPath|lock_conflict';
const SCOPES = ['src/foundation/process-manager', 'src/watchdog'];

describe('process spawn error taxonomy ratchet (Phase 1235)', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');

  it('ProcessManager + Watchdog production 无旧 lock 错误/字段/outcome', () => {
    for (const scope of SCOPES) {
      const cmd = `grep -rEn '${FORBIDDEN_RE}' ${path.join(repoRoot, scope)} --include='*.ts' || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      expect(out.trim()).toBe('');
    }
  });

  it('spawn taxonomy discriminant 存在（reason/location/operation 编译期可检）', () => {
    const typesFile = path.join(repoRoot, 'src/foundation/process-manager/types.ts');
    const cmd = `grep -En 'active_owner|spawn_in_progress|commit_lost' ${typesFile} || true`;
    expect(execSync(cmd, { encoding: 'utf8' }).trim()).not.toBe('');
  });

  it('Watchdog outcome discriminant 为 spawn_conflict', () => {
    const stateFile = path.join(repoRoot, 'src/watchdog/motion-restart-state.ts');
    const cmd = `grep -En "kind: 'spawn_conflict'" ${stateFile} || true`;
    expect(execSync(cmd, { encoding: 'utf8' }).trim()).not.toBe('');
  });
});
