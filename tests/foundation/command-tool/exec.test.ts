/**
 * exec tool ToolResult 空 output placeholder 行为（phase 96）。
 *
 * 验证空 output 时 placeholder 附加运行命令、长命令截断。
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { createExecTool, formatExecOutputForToolResult, processExecErrorToToolResult } from '../../../src/foundation/command-tool/exec.js';
import { COMMAND_TOOL_DEFAULT_TIMEOUT_MS, EXEC_COMMAND_PLACEHOLDER_CHARS, EXEC_MAX_OUTPUT } from '../../../src/foundation/command-tool/constants.js';
import { COMMAND_TOOL_AUDIT_EVENTS } from '../../../src/foundation/command-tool/audit-events.js';
import { ProcessExecError, resolveHostCommand } from '../../../src/foundation/process-exec/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { assertWellFormedUnicode, truncateUtf8Prefix } from '../../../src/foundation/node-utils/utf8.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { cleanupTempDir, createTempDir } from '../../utils/temp.js';
import {
  EMPTY_OUTPUT_COMMAND,
  IS_WINDOWS,
  LONG_EMPTY_OUTPUT_COMMAND,
  NON_ZERO_EXIT_COMMAND,
} from './platform-commands.js';

const execTool = createExecTool();

function parseReadHint(content: string): string | undefined {
  const json = /^  read: (\{.*\})$/m.exec(content)?.[1];
  return json === undefined
    ? undefined
    : (JSON.parse(json) as { path: string }).path;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('phase 2062 L1 host invocation exec tool description', () => {
  it('interpolates the L1 invocation without platform-specific examples or schema expansion', () => {
    const props = execTool.schema.properties as Record<string, { description?: string }>;
    const { invocation } = resolveHostCommand('');

    expect(execTool.description).toContain(`Runs via \`${invocation}\``);
    expect(execTool.description).toContain('commands and syntax supported by that interpreter');
    expect(execTool.description).toContain('powershell.exe -NoProfile -Command');
    expect(props.command.description).toContain('supported by the host interpreter');
    expect(props.command.description).not.toContain('dir');
    expect(props.command.description).not.toContain('findstr');
    expect(props.command.description).not.toContain('ls -la');
    expect(props).not.toHaveProperty('shell');
    expect(props.stdin.description).toContain('pipe directly');
    expect(props.stdin.description).toContain('not parsed by the shell');
  });
});

describe('phase 96 exec empty-output placeholder', () => {
  it('exit 0 + empty output → content carries (no output) + [command]', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const result = await execTool.execute({ command: EMPTY_OUTPUT_COMMAND }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('(no output)');
    expect(result.content).toContain(`[command]: ${EMPTY_OUTPUT_COMMAND}`);
  });

  it('non-zero exit + empty output → content has [exit N] + (no output) + [command]', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const result = await execTool.execute({ command: NON_ZERO_EXIT_COMMAND }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toMatch(/\[exit 1\]/);
    expect(result.content).toContain('(no output)');
    expect(result.content).toContain(`[command]: ${NON_ZERO_EXIT_COMMAND}`);
  });

  it('long command (> 200 chars) truncated in placeholder', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const longCmd = LONG_EMPTY_OUTPUT_COMMAND;
    const result = await execTool.execute({ command: longCmd }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('(no output)');
    expect(result.content).toContain('[command]: ');
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

describe('phase 2061 real Windows cmd behavior', () => {
  it.runIf(IS_WINDOWS)('supports cmd pipes', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const result = await execTool.execute({ command: 'echo phase2061 | findstr phase2061' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('phase2061');
  });

  it.runIf(IS_WINDOWS)('supports cmd redirection and paths containing spaces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2061-cmd-'));
    try {
      const ctx = makeExecContext({ workspaceDir: dir });
      const result = await execTool.execute({ command: 'echo phase2061 > "output file.txt"' }, ctx);

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'output file.txt'), 'utf8').trim()).toBe('phase2061');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(IS_WINDOWS)('preserves quoted arguments containing spaces', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const result = await execTool.execute({ command: 'echo "hello world"' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('hello world');
  });

  it.runIf(IS_WINDOWS)('supports explicit PowerShell without making it the default shell', async () => {
    const ctx = makeExecContext({ workspaceDir: process.cwd() });
    const result = await execTool.execute({
      command: 'powershell.exe -NoProfile -Command "Write-Output \'phase2061\'"',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content.trim()).toBe('phase2061');
  });
});

describe('phase 2107 exec UTF-8 overflow preview', () => {
  it('真实 FS 保存完整输出，预览与提示按 UTF-8 字节守恒', async () => {
    const tempDir = await createTempDir();
    try {
      const workspaceDir = path.join(tempDir, 'clawspace');
      const syncDir = path.join(tempDir, 'tasks', 'sync');
      await fs.promises.mkdir(workspaceDir, { recursive: true });
      const ctx = makeExecContext({
        clawDir: tempDir,
        workspaceDir,
        syncDir,
        fs: new NodeFileSystem({ baseDir: tempDir }),
      });
      const output = `${'a'.repeat(599)}😀${'中'.repeat(1000)}😀${'z'.repeat(1399)}`;
      expect(output.length).toBeGreaterThan(EXEC_MAX_OUTPUT);

      const content = await formatExecOutputForToolResult(ctx, output);

      expect(content.startsWith(`${'a'.repeat(599)}\n[...truncated 3008 bytes...]\n`)).toBe(true);
      expect(content).toContain(`${'z'.repeat(1399)}\nFull output (${Buffer.byteLength(output, 'utf8')} bytes) saved.`);
      expect(() => assertWellFormedUnicode(content)).not.toThrow();
      expect(content).not.toContain('\uFFFD');
      const relPath = parseReadHint(content);
      expect(relPath).toBeDefined();
      const artifact = await fs.promises.readFile(path.resolve(workspaceDir, relPath!), 'utf8');
      expect(artifact.endsWith(output)).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('phase 2126 exec overflow path serialization', () => {
  it.runIf(!IS_WINDOWS)('特殊字符与长路径提示可解析并读回真实 artifact', async () => {
    const tempDir = await createTempDir();
    try {
      const workspaceDir = path.join(tempDir, 'clawspace');
      const longSegments = Array.from({ length: 5 }, (_, i) => `${i}-${'p'.repeat(120)}`);
      const syncDir = path.join(tempDir, 'tasks', 'sync"\\\nphase2126', ...longSegments);
      await fs.promises.mkdir(workspaceDir, { recursive: true });
      const ctx = makeExecContext({
        clawDir: tempDir,
        workspaceDir,
        syncDir,
        fs: new NodeFileSystem({ baseDir: tempDir }),
      });
      const output = 'x'.repeat(EXEC_MAX_OUTPUT + 1);

      const content = await formatExecOutputForToolResult(ctx, output);
      const relPath = parseReadHint(content);

      expect(relPath).toBeDefined();
      expect(Buffer.byteLength(relPath!, 'utf8')).toBeGreaterThan(600);
      const artifact = await fs.promises.readFile(path.resolve(workspaceDir, relPath!), 'utf8');
      expect(artifact.endsWith(output)).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('phase 2110 exec UTF-8 byte threshold', () => {
  const cases = [
    { name: 'ASCII 1999B', output: 'a'.repeat(1999), overflows: false },
    { name: 'ASCII 2000B', output: 'a'.repeat(2000), overflows: false },
    { name: 'ASCII 2001B', output: 'a'.repeat(2001), overflows: true },
    { name: 'Chinese exactly 2000B', output: `${'中'.repeat(666)}ab`, overflows: false },
    { name: 'Chinese 2001B', output: '中'.repeat(667), overflows: true },
    { name: 'emoji exactly 2000B', output: '😀'.repeat(500), overflows: false },
    { name: 'emoji 2004B', output: '😀'.repeat(501), overflows: true },
  ];

  it.each(cases)('$name: formatter persists only strictly over 2000 bytes', async ({ output, overflows }) => {
    const tempDir = await createTempDir();
    try {
      const workspaceDir = path.join(tempDir, 'clawspace');
      const syncDir = path.join(tempDir, 'tasks', 'sync');
      await fs.promises.mkdir(workspaceDir, { recursive: true });
      const ctx = makeExecContext({
        clawDir: tempDir,
        workspaceDir,
        syncDir,
        fs: new NodeFileSystem({ baseDir: tempDir }),
      });

      const content = await formatExecOutputForToolResult(ctx, output);
      const overflowDir = path.join(syncDir, 'exec');
      const files = await fs.promises.readdir(overflowDir).catch(() => []);

      if (!overflows) {
        expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
        expect(content).toBe(output);
        expect(files).toHaveLength(0);
        return;
      }

      expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(EXEC_MAX_OUTPUT);
      expect(files).toHaveLength(1);
      expect(content).toContain(`Full output (${Buffer.byteLength(output, 'utf8')} bytes) saved.`);
      const artifact = await fs.promises.readFile(path.join(overflowDir, files[0]), 'utf8');
      expect(artifact.endsWith(output)).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('真实 createExecTool 将 2001B 中文 stdin→stdout 完整保存', async () => {
    const tempDir = await createTempDir();
    try {
      const workspaceDir = path.join(tempDir, 'clawspace');
      const syncDir = path.join(tempDir, 'tasks', 'sync');
      await fs.promises.mkdir(workspaceDir, { recursive: true });
      const ctx = makeExecContext({
        clawDir: tempDir,
        workspaceDir,
        syncDir,
        fs: new NodeFileSystem({ baseDir: tempDir }),
      });
      const output = '中'.repeat(667);
      const command = `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`;

      const result = await createExecTool().execute({ command, stdin: output }, ctx);

      expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(EXEC_MAX_OUTPUT);
      expect(output.length).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
      expect(result.success).toBe(true);
      expect(result.content).toContain('Full output (2001 bytes) saved.');
      const overflowDir = path.join(syncDir, 'exec');
      const files = await fs.promises.readdir(overflowDir);
      expect(files).toHaveLength(1);
      const artifact = await fs.promises.readFile(path.join(overflowDir, files[0]), 'utf8');
      expect(artifact.endsWith(output)).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});

describe('phase 2120 exec overflow durability results', () => {
  const outcomes: Array<Awaited<ReturnType<NodeFileSystem['writeAtomic']>>> = [
    { kind: 'durable' },
    {
      kind: 'committed_platform_limited',
      error: Object.assign(new Error('directory sync unsupported'), { code: 'ENOTSUP' }),
    },
    {
      kind: 'committed_durability_unknown',
      error: Object.assign(new Error('directory sync failed'), { code: 'EIO' }),
    },
  ];

  async function makeContext(tempDir: string) {
    const workspaceDir = path.join(tempDir, 'clawspace');
    const syncDir = path.join(tempDir, 'tasks', 'sync');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const events: Array<[string, ...(string | number)[]]> = [];
    const ctx = makeExecContext({
      clawDir: tempDir,
      workspaceDir,
      syncDir,
      fs: new NodeFileSystem({ baseDir: tempDir }),
      auditWriter: {
        write: (type: string, ...cols: (string | number)[]) => { events.push([type, ...cols]); },
        preview: (value: string) => value,
        message: (value: string) => value,
        summary: (value: string) => value,
      },
    });
    return { ctx, events, workspaceDir, syncDir };
  }

  function injectWriteResult(
    ctx: ReturnType<typeof makeExecContext>,
    outcome: Awaited<ReturnType<NodeFileSystem['writeAtomic']>>,
  ) {
    const realWrite = ctx.fs.writeAtomic.bind(ctx.fs);
    return vi.spyOn(ctx.fs, 'writeAtomic').mockImplementation(async (file, content) => {
      await realWrite(file, content);
      return outcome;
    });
  }

  it.each(outcomes)('preserves one real artifact and reports $kind without retrying', async outcome => {
    const tempDir = await createTempDir();
    try {
      const { ctx, events, workspaceDir } = await makeContext(tempDir);
      const write = injectWriteResult(ctx, outcome);
      const output = 'x'.repeat(EXEC_MAX_OUTPUT + 1);

      const content = await formatExecOutputForToolResult(ctx, output);

      expect(write).toHaveBeenCalledTimes(1);
      const relPath = parseReadHint(content);
      expect(relPath).toBeDefined();
      const artifact = await fs.promises.readFile(path.resolve(workspaceDir, relPath!), 'utf8');
      expect(artifact.endsWith(output)).toBe(true);
      expect(content).toContain(`Full output (${Buffer.byteLength(output, 'utf8')} bytes) saved.`);
      const durabilityEvents = events.filter(event =>
        event[0] === COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_PERSIST_FAILED);
      if (outcome.kind === 'durable') {
        expect(content).not.toContain('artifact committed but durability unconfirmed');
        expect(durabilityEvents).toHaveLength(0);
      } else {
        expect(content).toContain(`[artifact committed but durability unconfirmed: ${outcome.kind}]`);
        expect(content).toContain(`[reason]: `);
        expect(content).toContain(outcome.error.message);
        expect(content).toContain(`[path]: ${relPath}`);
        expect(content).not.toContain('durable');
        expect(durabilityEvents).toEqual([[
          COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_PERSIST_FAILED,
          'stage=durability',
          `commit=${outcome.kind}`,
          `path=${relPath}`,
          expect.stringContaining(`reason=`),
        ]]);
        expect(String(durabilityEvents[0][4])).toContain(outcome.error.message);
      }
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('keeps the existing failure fallback without a fake artifact path', async () => {
    const tempDir = await createTempDir();
    try {
      const { ctx, events, syncDir } = await makeContext(tempDir);
      const writeError = new Error('injected pre-commit failure');
      const write = vi.spyOn(ctx.fs, 'writeAtomic').mockRejectedValue(writeError);
      const output = 'x'.repeat(EXEC_MAX_OUTPUT + 1);

      const content = await formatExecOutputForToolResult(ctx, output);

      expect(write).toHaveBeenCalledTimes(1);
      expect(content).toContain('[truncated]');
      expect(content).not.toContain('Full output');
      expect(content).not.toContain('read:');
      expect(events).toEqual([[
        COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_PERSIST_FAILED,
        expect.stringContaining(writeError.message),
      ]]);
      expect(await fs.promises.readdir(path.join(syncDir, 'exec')).catch(() => [])).toHaveLength(0);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('keeps maxBuffer failure classification while disclosing committed durability', async () => {
    const tempDir = await createTempDir();
    try {
      const { ctx, events, syncDir } = await makeContext(tempDir);
      const outcome = outcomes[2];
      const write = injectWriteResult(ctx, outcome);
      const outputLength = 1024 * 1024 + 128;
      const command = `"${process.execPath}" -e "process.stdout.write('x'.repeat(${outputLength}))"`;

      const result = await createExecTool().execute({ command }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Error: command output exceeded 1 MB limit.');
      expect(result.content).toContain('[artifact committed but durability unconfirmed: committed_durability_unknown]');
      expect(result.content).toContain('directory sync failed');
      expect(result.content).toContain('[path]: ');
      expect(write).toHaveBeenCalledTimes(1);
      const files = await fs.promises.readdir(path.join(syncDir, 'exec'));
      expect(files).toHaveLength(1);
      const artifact = await fs.promises.readFile(path.join(syncDir, 'exec', files[0]), 'utf8');
      // L1 maxBuffer 只交付终止前实际捕获的 1 MiB；overflow 必须完整保留这批
      // captured bytes，不能把终止后未观察到的命令输出也算作 artifact 契约。
      expect(artifact.endsWith('x'.repeat(1024 * 1024))).toBe(true);
      expect(events.some(event =>
        event[0] === COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_PERSIST_FAILED &&
        event.includes('commit=committed_durability_unknown'))).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  }, 15_000);
});

describe('processExecErrorToToolResult', () => {
  const outputByteCases = [
    { name: 'Chinese real failure', output: '中'.repeat(1001), exitCode: null, killed: true, success: false },
    { name: 'emoji real failure', output: '😀'.repeat(501), exitCode: null, killed: true, success: false },
    { name: 'Chinese non-zero exit', output: '中'.repeat(1001), exitCode: 1, killed: false, success: true },
    { name: 'emoji non-zero exit', output: '😀'.repeat(501), exitCode: 1, killed: false, success: true },
  ];

  it.each(outputByteCases)('$name keeps the complete prefix and a UTF-8-safe output preview', ({ output, exitCode, killed, success }) => {
    const result = processExecErrorToToolResult(new ProcessExecError({
      message: 'Command failed',
      output,
      exitCode,
      killed,
    }), 'sleep 5');
    const prefix = success
      ? '[exit 1]\n[command]: sleep 5\n'
      : 'Error: Command failed\n[command]: sleep 5\n[output]: ';
    const previewBudget = EXEC_MAX_OUTPUT
      - Buffer.byteLength(prefix, 'utf8')
      - Buffer.byteLength('\n[truncated]', 'utf8');
    const preview = truncateUtf8Prefix(output, previewBudget);

    expect(result.success).toBe(success);
    expect(result.content).toBe(`${prefix}${preview}\n[truncated]`);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(result.content).not.toContain('\uFFFD');
  });

  it('keeps complete diagnostics and an explicit truncation notice when the prefix exceeds the budget', () => {
    const message = 'x'.repeat(EXEC_MAX_OUTPUT + 100);
    const result = processExecErrorToToolResult(new ProcessExecError({
      message,
      output: '中'.repeat(1001),
      exitCode: null,
      killed: true,
      termination: {
        status: 'gone',
        trigger: 'timeout',
        termSent: true,
        killSent: false,
      },
    }), 'sleep 5');
    const prefix = `Error: ${message}\n[command]: sleep 5\n[cleanup]: gone after SIGTERM\n[output]: `;

    expect(result.success).toBe(false);
    expect(result.content).toBe(`${prefix}\n[truncated]`);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeGreaterThan(EXEC_MAX_OUTPUT);
  });

  it('keeps short non-zero output unchanged and successful', () => {
    const result = processExecErrorToToolResult(new ProcessExecError({
      message: 'Command exited with code 1',
      output: 'partial output',
      exitCode: 1,
      killed: false,
    }), 'exit 1');

    expect(result).toEqual({
      success: true,
      content: '[exit 1]\n[command]: exit 1\npartial output',
    });
  });

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
