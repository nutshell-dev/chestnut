/**
 * CommandTool exec real timeout integration test (phase 1069, phase 1070 refactor).
 *
 * Covers the full wiring:
 *   createExecTool → exec → ProcessExec (timeout/kill) → ProcessExecError
 *   → processExecErrorToToolResult → ToolResult
 *
 * Belongs to integration-process project — uses real subprocess with sleep.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { createExecTool } from '../../../src/foundation/command-tool/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createOutboxWriter, OutboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('exec tool real timeout', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    const outboxWriter: OutboxWriter = createOutboxWriter('test-claw', tempDir, mockFs, makeAudit().audit);
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('real timeout captures partial output, killed state, and command in result', async () => {
    // printf partial output then block for 5s → clamped to 1000ms → SIGTERM
    const tool = createExecTool();
    const result = await tool.execute({
      command: "printf 'partial-output-before-timeout\\n' && sleep 5",
      timeoutMs: 1000,
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('1000ms');
    expect(result.content).toContain('printf');
    expect(result.content).toContain('partial-output-before-timeout');
    expect(result.content).toContain('[output]:');
  });
});
