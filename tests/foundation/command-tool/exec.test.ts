/**
 * exec tool ToolResult 空 output placeholder 行为（phase 96）。
 *
 * 验证空 output 时 placeholder 附加运行命令、长命令截断。
 */
import { describe, it, expect } from 'vitest';
import { createExecTool, processExecErrorToToolResult } from '../../../src/foundation/command-tool/exec.js';
import { EXEC_COMMAND_PLACEHOLDER_CHARS } from '../../../src/foundation/command-tool/constants.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';

const execTool = createExecTool();

describe('phase 96 exec empty-output placeholder', () => {
  it('exit 0 + empty output → content carries (no output) + [command]', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const result = await execTool.execute({ command: 'true' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('(no output)');
    expect(result.content).toContain('[command]: true');
  });

  it('non-zero exit + empty output → content has [exit N] + (no output) + [command]', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const result = await execTool.execute({ command: 'false' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toMatch(/\[exit 1\]/);
    expect(result.content).toContain('(no output)');
    expect(result.content).toContain('[command]: false');
  });

  it('long command (> 200 chars) truncated in placeholder', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const longCmd = 'true ' + '#'.repeat(500); // sh 注释、cmd 仍 exit 0、output 空
    const result = await execTool.execute({ command: longCmd }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('(no output)');
    expect(result.content).toContain('[command]: true');
    expect(result.content).toContain('[truncated]');
    // command 字符串部分（含 [command]: prefix 前缀）应不超 ~210（200 + prefix + truncated 标记）
    const commandLine = result.content
      .split('\n')
      .find((l) => l.startsWith('[command]:'));
    expect(commandLine).toBeDefined();
    expect(commandLine!.length).toBeLessThanOrEqual(
      EXEC_COMMAND_PLACEHOLDER_CHARS + '[command]: '.length + '[truncated]'.length,
    );
  });
});

describe('processExecErrorToToolResult', () => {
  it('maps a killed timeout to a failed ToolResult with command and output', () => {
    const error = new ProcessExecError({
      message: 'Command timed out after 1000ms',
      output: 'partial output',
      exitCode: null,
      killed: true,
    });

    expect(processExecErrorToToolResult(error, 'sleep 5')).toEqual({
      success: false,
      content: 'Error: Command timed out after 1000ms\n[command]: sleep 5\n[output]: partial output',
    });
  });

  // phase 1269 Step D: structured termination → user-visible cleanup line
  it('appends stable cleanup wording from structured termination facts', () => {
    const base = {
      message: 'Command timed out after 1000ms',
      output: '',
      exitCode: null,
      killed: true,
    };
    const identity = { leaderPid: 1234, processGroupId: 1234 };

    expect(processExecErrorToToolResult(new ProcessExecError({
      ...base,
      termination: { status: 'gone', trigger: 'timeout', termSent: true, killSent: false, identity },
    }), 'sleep 5').content).toContain('[cleanup]: gone after SIGTERM');

    expect(processExecErrorToToolResult(new ProcessExecError({
      ...base,
      termination: { status: 'gone', trigger: 'timeout', termSent: true, killSent: true, identity },
    }), 'sleep 5').content).toContain('[cleanup]: gone after SIGKILL');

    // 反向 2: indeterminate 不得写成 killed/cleaned 完成式表述
    const indeterminate = processExecErrorToToolResult(new ProcessExecError({
      ...base,
      termination: { status: 'indeterminate', trigger: 'abort', termSent: true, killSent: true, identity, reason: 'sigkill_send_failed' },
    }), 'sleep 5');
    expect(indeterminate.content).toContain('[cleanup]: indeterminate (sigkill_send_failed)');
    expect(indeterminate.content).not.toContain('gone');

    expect(processExecErrorToToolResult(new ProcessExecError({
      ...base,
      termination: { status: 'still_alive', trigger: 'timeout', termSent: true, killSent: true, identity },
    }), 'sleep 5').content).toContain('[cleanup]: still_alive after SIGKILL');

    expect(processExecErrorToToolResult(new ProcessExecError({
      ...base,
      termination: { status: 'gone', trigger: 'abort', termSent: false, killSent: false, reason: 'not_started' },
    }), 'sleep 5').content).toContain('[cleanup]: not_started');
  });
});
