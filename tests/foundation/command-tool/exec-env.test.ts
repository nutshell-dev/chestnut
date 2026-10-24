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

  async function makeCtx(subagentTaskId?: string, clawId = 'test-claw') {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const dir = path.join(os.tmpdir(), `exec-env-test-${randomUUID()}`);
    lastDir = dir;
    const fs = new NodeFileSystem({ baseDir: dir });
    await fs.ensureDir('.');
    const ctx = new ExecContextImpl({
      clawId,
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

  // phase 1986 Step G：每次 exec 注入调用者 agent 身份
  it('主代理 exec（无 subagentTaskId）→ CHESTNUT_CALLER_AGENT_ID = clawId', async () => {
    const { ctx } = await makeCtx();
    const tool = createExecTool();
    const result = await tool.execute({ command: 'echo "$CHESTNUT_CALLER_AGENT_ID"' }, ctx);
    expect(result.success).toBe(true);
    expect((result.content as string).trim()).toBe('test-claw');
    // 既有 subagent env 行为保留：未设时不注入
    const sub = await tool.execute({ command: 'echo "$CHESTNUT_SUBAGENT_TASK_ID"' }, ctx);
    expect((sub.content as string).trim()).toBe('');
  });

  it('子代理 exec → caller env 与 subagent task env 并存（同为 task id）', async () => {
    const { ctx } = await makeCtx('spawn-abc', 'spawn-abc');
    const tool = createExecTool();
    const result = await tool.execute(
      { command: 'echo "$CHESTNUT_CALLER_AGENT_ID/$CHESTNUT_SUBAGENT_TASK_ID"' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.content as string).trim()).toBe('spawn-abc/spawn-abc');
  });
});
