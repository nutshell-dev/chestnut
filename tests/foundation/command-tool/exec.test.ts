/**
 * exec tool ToolResult 空 output placeholder 行为（phase 96）。
 *
 * 验证空 output 时 placeholder 附加运行命令、长命令截断。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createExecTool, processExecErrorToToolResult } from '../../../src/foundation/command-tool/exec.js';
import { COMMAND_TOOL_DEFAULT_TIMEOUT_MS, EXEC_COMMAND_PLACEHOLDER_CHARS } from '../../../src/foundation/command-tool/constants.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';

const execTool = createExecTool();

// vitest 以进程 cwd 解析相对路径——source 路径用绝对路径（phase 1452 教训）
const EXEC_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/foundation/command-tool/exec.ts',
);

describe('phase 1472 Step B: agent exec 默认时限 ownership（CommandTool 三处同源）', () => {
  it('owner 常量 = 30_000，Tool default 与 schema description 同源', () => {
    expect(COMMAND_TOOL_DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(execTool.defaultTimeoutMs).toBe(COMMAND_TOOL_DEFAULT_TIMEOUT_MS);
    const props = execTool.schema.properties as Record<string, { description?: string }> | undefined;
    expect(props?.timeoutMs).toBeDefined();
    expect(props?.timeoutMs?.description).toContain(String(COMMAND_TOOL_DEFAULT_TIMEOUT_MS));
  });

  it('反向 ownership：exec.ts 不再消费 L1 默认 timeout 常量，agent fallback 显式同源', () => {
    const source = fs.readFileSync(EXEC_SOURCE, 'utf8');
    expect(source).not.toContain('PROCESS_EXEC_DEFAULT_TIMEOUT_MS');
    expect(source).toContain(
      'timeoutMs: (args.timeoutMs as number | undefined) ?? COMMAND_TOOL_DEFAULT_TIMEOUT_MS,',
    );
    // createExecWithHandle 低级入口不得获得 agent 默认值（透明语义）
    const withHandleRegion = source.slice(source.indexOf('createExecWithHandle'));
    expect(withHandleRegion).not.toContain('COMMAND_TOOL_DEFAULT_TIMEOUT_MS');
  });
});

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
