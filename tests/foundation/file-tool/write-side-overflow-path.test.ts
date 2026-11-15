import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';

import { readTool } from '../../../src/foundation/file-tool/read.js';
import { searchTool } from '../../../src/foundation/file-tool/search.js';
import { backupToSync } from '../../../src/foundation/file-tool/sync-backup.js';
import { formatExecOutputForToolResult } from '../../../src/foundation/command-tool/exec.js';
import { READ_OUTPUT_HARD_CAP_BYTES, SEARCH_PREVIEW_LIMIT } from '../../../src/foundation/file-tool/constants.js';
import { EXEC_MAX_OUTPUT } from '../../../src/foundation/command-tool/constants.js';
import { NodeFileSystem, type FileSystem } from '../../../src/foundation/fs/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { cleanupTempDir, createTempDir } from '../../utils/temp.js';

interface WriteCall {
  path: string;
  content: string;
}

describe('phase 2154 B7: baseDir-relative overflow and backup writes', () => {
  let tempDir: string;
  let callerDir: string;
  let callerWorkspace: string;
  let targetDir: string;
  let targetWorkspace: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    callerDir = path.join(tempDir, 'caller');
    targetDir = path.join(tempDir, 'target');
    callerWorkspace = path.join(callerDir, 'clawspace');
    targetWorkspace = path.join(targetDir, 'clawspace');
    await fs.mkdir(callerWorkspace, { recursive: true });
    await fs.mkdir(targetWorkspace, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeSourceSide() {
    const inner = new NodeFileSystem({ baseDir: targetDir });
    const writePaths: string[] = [];
    const existsPaths: string[] = [];
    const readPaths: string[] = [];
    const sourceFs = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'writeAtomic') {
          return async (p: string): Promise<never> => {
            writePaths.push(p);
            throw new Error('source-side writeAtomic must not be called');
          };
        }
        if (prop === 'exists') {
          return async (p: string) => {
            existsPaths.push(p);
            return target.exists(p);
          };
        }
        if (prop === 'read') {
          return async (p: string) => {
            readPaths.push(p);
            return target.read(p);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as FileSystem;
    return { sourceFs, writePaths, existsPaths, readPaths };
  }

  function makeWriteSide() {
    const inner = new NodeFileSystem({ baseDir: callerDir });
    const writeCalls: WriteCall[] = [];
    const toolOutput = {
      fs: {
        writeAtomic: async (p: string, content: string) => {
          if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
            throw new Error(`writeAtomic requires a baseDir-relative path: ${p}`);
          }
          writeCalls.push({ path: p, content });
          return inner.writeAtomic(p, content);
        },
      },
      baseDir: callerDir,
      syncDir: path.join(callerDir, 'syncDir-must-not-be-used'),
      workspaceDir: callerWorkspace,
    };
    return { toolOutput, writeCalls };
  }

  function makeTargetCtx(
    source: ReturnType<typeof makeSourceSide>,
    output: ReturnType<typeof makeWriteSide>,
  ) {
    const ctx = new ExecContextImpl({
      clawId: 'target-claw',
      clawDir: targetDir,
      workspaceDir: targetWorkspace,
      syncDir: path.join(targetDir, 'tasks', 'sync'),
      profile: 'full',
      fs: source.sourceFs,
      auditWriter: makeMockAudit(),
      permissionChecker: createClawPermissionChecker({
        audit: makeMockAudit(),
        clawDir: targetDir,
        strict: true,
        fs: source.sourceFs,
      }),
    });
    Object.assign(ctx, { toolOutput: output.toolOutput });
    return ctx;
  }

  function onlyWrite(output: ReturnType<typeof makeWriteSide>, kind: string): WriteCall {
    expect(output.writeCalls).toHaveLength(1);
    const call = output.writeCalls[0]!;
    expect(path.isAbsolute(call.path)).toBe(false);
    expect(call.path).toMatch(new RegExp(`^tasks/sync/${kind}/[^/]+\\.md$`));
    return call;
  }

  async function readDisplayedArtifact(displayPath: string | undefined, write: WriteCall): Promise<string> {
    expect(displayPath).toBeDefined();
    expect(path.isAbsolute(displayPath!)).toBe(false);
    const expectedAbsolute = path.join(callerDir, write.path);
    expect(path.resolve(callerWorkspace, displayPath!)).toBe(expectedAbsolute);
    expect(displayPath).toBe(path.relative(callerWorkspace, expectedAbsolute));
    return fs.readFile(expectedAbsolute, 'utf8');
  }

  async function targetArtifacts(kind: string): Promise<string[]> {
    return fs.readdir(path.join(targetDir, 'tasks', 'sync', kind)).catch(() => []);
  }

  function parseReadHint(content: string): string | undefined {
    const json = /^  read: (\{.*\})$/m.exec(content)?.[1];
    return json === undefined ? undefined : (JSON.parse(json) as { path: string }).path;
  }

  function parseSearchHint(content: string): string | undefined {
    const json = /read\(\{ "path": (".+?"), "offset": 1, "limit": 200 \}\)/.exec(content)?.[1];
    return json === undefined ? undefined : JSON.parse(json) as string;
  }

  it('read 从 target 读取，只向 toolOutput 写相对路径且提示可读', async () => {
    const sourceText = `READ-TARGET\n${'x'.repeat(READ_OUTPUT_HARD_CAP_BYTES)}`;
    await fs.writeFile(path.join(targetWorkspace, 'source.txt'), sourceText);
    const source = makeSourceSide();
    const output = makeWriteSide();

    const result = await readTool.execute({ path: 'source.txt' }, makeTargetCtx(source, output));

    expect(result.success).toBe(true);
    const write = onlyWrite(output, 'read');
    expect(source.writePaths).toEqual([]);
    const artifact = await readDisplayedArtifact(parseReadHint(result.content), write);
    expect(artifact.endsWith(sourceText)).toBe(true);
    expect(write.content).toContain('source: read_overflow');
    expect(await targetArtifacts('read')).toEqual([]);
  });

  it('search 从 target 扫描，只向 toolOutput 写相对路径且提示可读', async () => {
    const sourceText = Array.from(
      { length: SEARCH_PREVIEW_LIMIT + 1 },
      (_, i) => `needle SEARCH-TARGET-${i}`,
    ).join('\n');
    await fs.writeFile(path.join(targetWorkspace, 'source.txt'), sourceText);
    const source = makeSourceSide();
    const output = makeWriteSide();

    const result = await searchTool.execute({ text: 'needle' }, makeTargetCtx(source, output));

    expect(result.success).toBe(true);
    const write = onlyWrite(output, 'search');
    expect(source.writePaths).toEqual([]);
    const artifact = await readDisplayedArtifact(parseSearchHint(result.content), write);
    expect(artifact).toContain(`SEARCH-TARGET-${SEARCH_PREVIEW_LIMIT}`);
    expect(write.content).toContain('source: search_overflow');
    expect(await targetArtifacts('search')).toEqual([]);
  });

  it('exec overflow 只向 toolOutput 写相对路径且提示可读', async () => {
    const outputText = `EXEC-TARGET\n${'x'.repeat(EXEC_MAX_OUTPUT)}`;
    const source = makeSourceSide();
    const output = makeWriteSide();

    const content = await formatExecOutputForToolResult(makeTargetCtx(source, output), outputText);

    const write = onlyWrite(output, 'exec');
    expect(source.writePaths).toEqual([]);
    const artifact = await readDisplayedArtifact(parseReadHint(content), write);
    expect(artifact.endsWith(outputText)).toBe(true);
    expect(write.content).toContain('source: exec_overflow');
    expect(await targetArtifacts('exec')).toEqual([]);
  });

  it('backup 的 exists/read 留在 source，artifact 写 toolOutput 且路径可读', async () => {
    const sourceText = 'BACKUP-TARGET-ORIGINAL';
    await fs.writeFile(path.join(targetWorkspace, 'source.txt'), sourceText);
    const source = makeSourceSide();
    const output = makeWriteSide();

    const result = await backupToSync(
      makeTargetCtx(source, output),
      'clawspace/source.txt',
      'edit_backup',
    );

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.durability).toBe('durable');
    const write = onlyWrite(output, 'write');
    expect(source.writePaths).toEqual([]);
    expect(source.existsPaths).toEqual(['clawspace/source.txt']);
    expect(source.readPaths).toEqual(['clawspace/source.txt']);
    const artifact = await readDisplayedArtifact(result.path, write);
    expect(artifact.endsWith(sourceText)).toBe(true);
    expect(write.content).toContain('source: edit_backup');
    expect(await targetArtifacts('write')).toEqual([]);
  });
});
