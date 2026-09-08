import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const FILE_TOOL_WRITE_CALLERS = [
  'src/foundation/file-tool/write.ts',
  'src/foundation/file-tool/edit.ts',
  'src/foundation/file-tool/multi_edit.ts',
];

describe('GuardedWrite canonical binding boundary (phase 1817)', () => {
  it('ToolProtocol owns GuardedWrite and the prepareWrite capability entry', () => {
    const def = read('src/foundation/tool-protocol/permission.ts');
    expect(def).toMatch(/export interface GuardedWrite/);
    expect(def).toMatch(/prepareWrite\(relativePath: string\): Promise<GuardedWrite>/);
    expect(read('src/foundation/tool-protocol/index.ts')).toMatch(
      /export type \{ PermissionChecker, GuardedWrite \} from '\.\/permission\.js';/,
    );
  });

  it('Permissions owner is the only prepareWrite implementation', () => {
    expect(read('src/core/permissions/claw-permissions.ts')).toMatch(/async prepareWrite\(/);
    const srcDir = path.join(root, 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const rel = path.relative(root, full);
          if (
            rel !== 'src/core/permissions/claw-permissions.ts' &&
            rel !== 'src/foundation/tool-protocol/permission.ts' &&
            /prepareWrite\s*\(/.test(fs.readFileSync(full, 'utf8')) &&
            /(async\s+prepareWrite|prepareWrite\s*[:=])/.test(fs.readFileSync(full, 'utf8'))
          ) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('file-tool write callers go through prepareWrite, never resolveAndCheck write', () => {
    for (const file of FILE_TOOL_WRITE_CALLERS) {
      const src = read(file);
      expect(src).toMatch(/prepareWrite\(/);
      expect(src).not.toMatch(/resolveAndCheck\([^)]*'write'/);
    }
  });

  it('no bare-path target write I/O after the permission check', () => {
    // write.ts / edit-commit.ts 的写目标 I/O 必须经 GuardedWrite capability；
    // ctx.fs 裸 path 写（writeAtomic/append）回流即重新打开 check→I/O TOCTOU 窗口。
    for (const file of ['src/foundation/file-tool/write.ts', 'src/foundation/file-tool/edit-commit.ts']) {
      const src = read(file);
      expect(src).not.toMatch(/ctx\.fs\.writeAtomic\(/);
      expect(src).not.toMatch(/ctx\.fs\.append\(/);
    }
  });

  it('classification runs on the canonical target relative path', () => {
    const impl = read('src/core/permissions/claw-permissions.ts');
    // canonicalize（realpath + 祖先 fallback）后分类，且 capability 绑定 canonicalRel
    expect(impl).toMatch(/canonicalizeTarget/);
    expect(impl).toMatch(/classifyWriteRelative\(canonicalRel, joined, options\)/);
    expect(impl).toMatch(/return bind\(canonical, canonicalRel\)/);
  });
});
