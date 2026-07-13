import { describe, it, expect, afterEach } from 'vitest';
import { createExecTool } from '../../../src/foundation/command-tool/exec.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs';
import { randomUUID } from 'crypto';

describe('exec tool env injection', () => {
  let lastDir: string;

  afterEach(() => {
    if (lastDir) {
      try {
        fs.rmSync(lastDir, { recursive: true, force: true });
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
      lastDir = '';
    }
  });

  async function makeCtx(subagentTaskId?: string) {
    const dir = path.join(os.tmpdir(), `exec-env-test-${randomUUID()}`);
    lastDir = dir;
    const fs = new NodeFileSystem({ baseDir: dir });
    await fs.ensureDir('.');
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: dir,
      profile: 'full',
      callerType: 'spawn_subagent',
      fs,
      maxSteps: 10,
      workspaceDir: dir,
      syncDir: path.join(dir, 'tasks/sync'),
      subagentTaskId,
    } as any);
    return { ctx, dir };
  }

  it('ctx.subagentTaskId set → spawn child env contains CHESTNUT_SUBAGENT_TASK_ID', async () => {
    const { ctx } = await makeCtx('task-fixture-123');
    const tool = createExecTool();
    const result = await tool.execute({ command: 'echo "$CHESTNUT_SUBAGENT_TASK_ID"' }, ctx);
    expect(result.success).toBe(true);
    expect((result.content as string).trim()).toBe('task-fixture-123');
  });

  it('ctx.subagentTaskId unset → env not injected', async () => {
    const { ctx } = await makeCtx();
    const tool = createExecTool();
    const result = await tool.execute({ command: 'echo "$CHESTNUT_SUBAGENT_TASK_ID"' }, ctx);
    expect(result.success).toBe(true);
    expect((result.content as string).trim()).toBe('');
  });
});
