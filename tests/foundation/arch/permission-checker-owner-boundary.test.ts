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
