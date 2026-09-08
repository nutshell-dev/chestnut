import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('PermissionChecker owner boundary (phase 1496)', () => {
  it('ToolProtocol remains the definition and named-export owner', () => {
    expect(read('src/foundation/tool-protocol/permission.ts')).toMatch(/export interface PermissionChecker/);
    expect(read('src/foundation/tool-protocol/index.ts')).toMatch(/export type \{ PermissionChecker \}/);
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
    expect(implementation).toMatch(/import type \{ PermissionChecker \} from '\.\.\/\.\.\/foundation\/tool-protocol\/index\.js';/);
    expect(implementation).toMatch(/\): PermissionChecker \{/);
  });
});

describe('Permissions canonical guard 必需化（phase 1818）', () => {
  const impl = () => read('src/core/permissions/claw-permissions.ts');

  it('checker 构造期必须接收 canonical resolve capability（fs 非 optional）', () => {
    const src = impl();
    expect(src).toMatch(/export type ClawPermissionFs = Pick<FileSystem, 'resolve'>;/);
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
