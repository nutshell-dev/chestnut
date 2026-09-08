import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('PermissionChecker owner boundary (phase 1496)', () => {
  it('ToolProtocol remains the definition and named-export owner', () => {
    expect(read('src/foundation/tool-protocol/permission.ts')).toMatch(/export interface PermissionChecker/);
    expect(read('src/foundation/tool-protocol/index.ts')).toMatch(/export type \{ PermissionChecker, GuardedWrite \}/);
  });

  it('Permissions implementation does not re-export PermissionChecker', () => {
    expect(read('src/core/permissions/claw-permissions.ts')).not.toMatch(/export type \{ PermissionChecker \}/);
  });

  it('Permissions barrel exposes the factory but not the protocol type', () => {
    const barrel = read('src/core/permissions/index.ts');
    expect(barrel).toMatch(/export \{ createClawPermissionChecker \}/);
    expect(barrel).not.toMatch(/\bPermissionChecker\b/);
  });

  it('Permissions imports the owner type for the factory return signature', () => {
    const implementation = read('src/core/permissions/claw-permissions.ts');
    expect(implementation).toMatch(/import type \{ PermissionChecker, GuardedWrite \} from '\.\.\/\.\.\/foundation\/tool-protocol\/index\.js';/);
    expect(implementation).toMatch(/\): PermissionChecker \{/);
  });
});

describe('Permissions canonical guard 必需化（phase 1818）', () => {
  const impl = () => read('src/core/permissions/claw-permissions.ts');

  it('checker 构造期必须接收 canonical resolve capability（fs 非 optional）', () => {
    const src = impl();
    // phase 1817: prepareWrite 消费 realpath/writeAtomic/append——最小接口加宽为四方法 Pick
    expect(src).toMatch(/export type ClawPermissionFs = Pick<FileSystem, 'resolve' \| 'realpath' \| 'writeAtomic' \| 'append'>;/);
    expect(src).toMatch(/\n  fs: ClawPermissionFs;/);
    expect(src).not.toMatch(/\nfs\?:/);
  });

  it('词法 path.resolve fallback 已删除（canonical 判定始终走 owner filesystem）', () => {
    expect(impl()).not.toMatch(/path\.resolve\(/);
  });

  it('factory 对缺失/残缺 fs（含 as any 绕过）构造期显式抛错', () => {
    const src = impl();
    expect(src).toMatch(/typeof options\.fs\.resolve !== 'function'/);
    expect(src).toMatch(/canonical resolve is required/);
  });
});

describe('Permissions writable hint 单源化（phase 1819）', () => {
  it('errors.ts 无手写 allowlist 镜像（hint 由 policy owner 注入）', () => {
    const errors = read('src/core/permissions/errors.ts');
    expect(errors).not.toMatch(/WRITABLE_ALLOWLIST_HINT/);
    // 手写路径清单字面量不得残留（真实 policy 成员如 'memory' 不出现在 errors.ts）
    expect(errors).not.toMatch(/'MEMORY\.md, memory/);
    expect(errors).toMatch(/formatWritableAllowlist\(paths: readonly string\[\]\)/);
  });

  it('policy owner deny 构造携带真实 writablePaths（单源：buildWritablePaths）', () => {
    const src = read('src/core/permissions/claw-permissions.ts');
    expect(src).toMatch(/function buildWritablePaths\(taskSyncDirs\?:/);
    expect(src).toMatch(/new WriteOperationForbiddenError\(targetPath, 'outside_allowlist', writablePaths\)/);
    // BASE_WRITABLE_PATHS 保持模块私有（不公开、不经 barrel）
    expect(src).not.toMatch(/export const BASE_WRITABLE_PATHS/);
    expect(read('src/core/permissions/index.ts')).not.toMatch(/BASE_WRITABLE_PATHS/);
  });
});
