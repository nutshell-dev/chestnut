/**
 * Phase 1235 ratchet: ProcessManager spawn 错误 taxonomy 已分型为
 * ProcessSpawnConflictError（合法竞争：active_owner | spawn_in_progress | commit_lost）
 * 与 ProcessGenerationStateError（malformed generation state）。旧 lock 语义
 * （LockConflictError / lockPath / lock_conflict outcome）不得回流任何 production scope。
 *
 * Phase 1239: Assembly 兼容面（LockConflictError 自 host + ASSEMBLE_LOCK_CONFLICT
 * 常量/routing）已清退，ratchet scope 扩至全部 production `src/`，禁止任何模块重新引入
 * 旧 taxonomy。
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const FORBIDDEN_RE = 'LockConflictError|lockPath|lock_conflict';
const SCOPES = ['src'];

describe('process spawn error taxonomy ratchet (Phase 1235)', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');

  it('全部 production src 无旧 lock 错误/字段/outcome', () => {
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
