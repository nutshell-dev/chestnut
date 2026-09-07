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

import { createExecTool } from '../../../src/foundation/command-tool/exec.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createOutboxWriter, OutboxWriter } from '../../../src/foundation/messaging/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('exec tool real timeout', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    const outboxWriter: OutboxWriter = createOutboxWriter('test-claw', tempDir, mockFs, makeAudit().audit);
    const audit = makeAudit();
    auditEvents = audit.events;
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true }),
      auditWriter: audit.audit,
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
    // phase 1269 Step D: structured cleanup conclusion is user-visible
    expect(result.content).toContain('[cleanup]: gone after SIGTERM');
  });

  it('real timeout cleans up same-group descendants and audits termination facts (反向 1)', async () => {
    const pidFile = path.join(tempDir, 'clawspace', 'sleep.pid');
    const tool = createExecTool();
    const result = await tool.execute({
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      timeoutMs: 1000,
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('[cleanup]: gone after SIGTERM');

    // After the tool returns, the same-group descendant must not survive.
    const sleepPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    expect(sleepPid).toBeGreaterThan(0);
    expect(isAlivePid(sleepPid)).toBe(false);

    // L2-owned audit carries the L1 facts (status/trigger/signals/identity).
    const termEvents = auditEvents.filter(([t]) => t === 'exec_termination');
    expect(termEvents).toHaveLength(1);
    const cols = termEvents[0].slice(1).map(String);
    expect(cols).toContain('status=gone');
    expect(cols).toContain('trigger=timeout');
    expect(cols).toContain('term_sent=true');
    expect(cols.some((c) => c.startsWith('leader_pid='))).toBe(true);
    expect(cols.some((c) => c.startsWith('process_group_id='))).toBe(true);
  }, 15_000);

  it('executor timeout waits for exec cleanup barrier before returning (反向 1)', async () => {
    const pidFile = path.join(tempDir, 'clawspace', 'sleep.pid');
    const registry = new ToolRegistryImpl();
    registry.register(createExecTool());
    const executor = new ToolExecutorImpl(registry, 60_000);

    const result = await executor.execute({
      toolName: 'exec',
      args: { command: `sleep 30 & echo $! > ${pidFile}; wait` },
      ctx,
      timeoutMs: 1000,
    });

    // User result is the timeout, but the barrier already confirmed cleanup.
    expect(result.success).toBe(false);
    expect(result.content).toContain('execution limit');

    const sleepPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    expect(isAlivePid(sleepPid)).toBe(false);

    const toolExec = auditEvents.filter(([t]) => t === 'tool_exec');
    expect(toolExec).toHaveLength(1);
    expect(toolExec[0].map(String)).toContain('cleanup=settled');

    const termEvents = auditEvents.filter(([t]) => t === 'exec_termination');
    expect(termEvents).toHaveLength(1);
    expect(termEvents[0].map(String)).toContain('trigger=abort');
    expect(termEvents[0].map(String)).toContain('status=gone');
  }, 15_000);
});
