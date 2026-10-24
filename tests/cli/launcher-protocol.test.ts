/**
 * launcher-protocol tests (phase 1990 Step B/D)
 *
 * Invariants:
 * 1. send stdout 只含 launcher.v1 envelope：成功唯一 ack（requestId 回带），失败 error + 非零
 * 2. stream stdout 每行均为 envelope；event 只映射 text_delta/send_content_delta 为累积快照
 * 3. envelope sequence 会话内严格连号；sessionId 稳定
 * 4. SIGINT/SIGTERM 写 terminal；daemon_dead 写 error(daemon_stopped)（后者见 claw-stream.test.ts）
 * 5. 人类提示一律 stderr，不进协议 stdout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { sendCommand } from '../../src/cli/commands/claw-send.js';
import { streamCommand } from '../../src/cli/commands/claw-stream.js';
import { getGlobalConfigPath } from '../../src/assembly/config/global-config-path.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/index.js';
import { LauncherEventMapper } from '../../src/cli-protocol/index.js';
import type { StreamReader } from '../../src/foundation/stream/index.js';
import { makeClawCommandDeps, type FakeClawCommandDeps } from '../helpers/claw-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/global-config-path.js')>();
  return { ...actual, getGlobalConfigPath: vi.fn() };
});
vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  return { ...actual, createProcessManagerForCLI: vi.fn(() => ({ isAlive: vi.fn(), liveness: vi.fn(() => ({ kind: 'dead', pid: 0 })) })) };
});

// ---------------------------------------------------------------------------
// send 协议
// ---------------------------------------------------------------------------
describe('send launcher.v1 envelope', () => {
  let tmpRoot: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let commandDeps: FakeClawCommandDeps;

  function stdoutLines(): any[] {
    const text = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
    return text.trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l));
  }

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase1990-send-${randomUUID()}`);
    const chestnutRoot = path.join(tmpRoot, '.chestnut');
    fs.mkdirSync(path.join(chestnutRoot, 'claws', 'test-claw'), { recursive: true });
    fs.writeFileSync(path.join(chestnutRoot, 'claws', 'test-claw', 'config.yaml'), 'name: test-claw\n');
    process.env.CHESTNUT_ROOT = tmpRoot;
    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(chestnutRoot, 'config.yaml'));
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    commandDeps = makeClawCommandDeps(fsFactory);
  });

  afterEach(() => {
    delete process.env.CHESTNUT_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('成功：stdout 唯一 ack envelope，字段齐全，requestId 回带', async () => {
    await sendCommand(commandDeps, 'test-claw', 'hello', { requestId: 'req-42' });

    const envelopes = stdoutLines();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      protocolVersion: 'chestnut.launcher.v1',
      sequence: 1,
      kind: 'ack',
      payload: { accepted: true, claw: 'test-claw', requestId: 'req-42' },
    });
    expect(typeof envelopes[0].sessionId).toBe('string');
    expect(envelopes[0].sessionId.length).toBeGreaterThan(0);
  });

  it('成功但无 requestId：ack payload 不含 requestId 字段', async () => {
    await sendCommand(commandDeps, 'test-claw', 'hello');
    expect(stdoutLines()[0].payload).not.toHaveProperty('requestId');
  });

  it('失败（claw 不存在）：stdout error envelope + 错误继续抛出', async () => {
    // loadClaw 返回 undefined = claw 不存在（assertPublishedClaw 抛 CliError）
    const missingDeps = makeClawCommandDeps(fsFactory, { loadClaw: () => undefined });
    await expect(sendCommand(missingDeps, 'ghost-claw', 'hello')).rejects.toThrow();

    const envelopes = stdoutLines();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      protocolVersion: 'chestnut.launcher.v1',
      kind: 'error',
      payload: { class: 'rejected' },
    });
  });
});

// ---------------------------------------------------------------------------
// stream 协议
// ---------------------------------------------------------------------------
const streamMocks = vi.hoisted(() => {
  const signalHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const reader = {
    start: vi.fn<(offset?: number) => void>(),
    stop: vi.fn<() => Promise<void>>(),
  };
  let onEvent: ((event: unknown) => void) | null = null;
  return { signalHandlers, reader, get onEvent() { return onEvent; }, set onEvent(cb) { onEvent = cb; } };
});

vi.mock('../../src/foundation/stream/index.js', () => ({
  STREAM_FILE: 'stream.jsonl',
  createStreamReader: vi.fn((_fs: unknown, _file: unknown, onEvent: (event: unknown) => void) => {
    streamMocks.onEvent = onEvent;
    return streamMocks.reader as unknown as StreamReader;
  }),
  findRecentTurnStartOffset: vi.fn(() => 0),
}));

vi.mock('../../src/foundation/claw-identity/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/claw-identity/index.js')>()),
  // env 感知：send 测试经 CHESTNUT_ROOT 驱动真实 tmp 实例；stream 测试未设 env 时用固定路径。
  getChestnutRoot: vi.fn(() => {
    const root = process.env.CHESTNUT_ROOT;
    return root ? path.join(root, '.chestnut') : '/tmp/chestnut';
  }),
}));

vi.mock('../../src/core/claw-topology/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/claw-topology/index.js')>()),
  resolveClawDaemonDir: vi.fn((name: string) => path.join('/tmp/chestnut/claws', name, 'daemon')),
}));

describe('stream launcher.v1 envelope', () => {
  let commandDeps: FakeClawCommandDeps;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;

  const mockFsFactory = (dir: string) => ({ baseDir: dir }) as unknown as ReturnType<FakeClawCommandDeps['fsFactory']>;

  function stdoutEnvelopes(): any[] {
    const text = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
    return text.trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l));
  }

  beforeEach(() => {
    commandDeps = makeClawCommandDeps(mockFsFactory);
    streamMocks.signalHandlers.SIGINT = [];
    streamMocks.signalHandlers.SIGTERM = [];
    streamMocks.reader.start.mockReset();
    streamMocks.reader.stop.mockReset();
    streamMocks.reader.stop.mockResolvedValue(undefined);
    streamMocks.onEvent = null;
    vi.mocked(getGlobalConfigPath).mockReturnValue('/tmp/chestnut/config.yaml');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    onSpy = vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (!streamMocks.signalHandlers[event]) streamMocks.signalHandlers[event] = [];
      streamMocks.signalHandlers[event].push(handler);
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('text_delta 同 trace 累积快照：同 messageId、sequence 连号、其余事件不转发', async () => {
    await streamCommand(commandDeps, 'test-claw');
    const emit = streamMocks.onEvent!;
    emit({ ts: 1, type: 'turn_start', sources: [] });
    emit({ ts: 2, type: 'text_delta', delta: '你', trace_id: 't1' });
    emit({ ts: 3, type: 'provider_info', name: 'kimi' });
    emit({ ts: 4, type: 'text_delta', delta: '好', trace_id: 't1' });
    emit({ ts: 5, type: 'text_delta', delta: '呀', trace_id: 't1' });

    const envelopes = stdoutEnvelopes();
    expect(envelopes).toHaveLength(3);
    expect(envelopes.map(e => e.sequence)).toEqual([1, 2, 3]);
    for (const e of envelopes) {
      expect(e.protocolVersion).toBe('chestnut.launcher.v1');
      expect(e.kind).toBe('event');
      expect(e.sessionId).toBe(envelopes[0].sessionId);
    }
    expect(envelopes[0].payload).toEqual({ messageId: 'text-t1', role: 'motion', text: '你' });
    expect(envelopes[1].payload).toEqual({ messageId: 'text-t1', role: 'motion', text: '你好' });
    expect(envelopes[2].payload).toEqual({ messageId: 'text-t1', role: 'motion', text: '你好呀' });
  });

  it('send_content_delta 映射为 reply- 前缀消息；trace 切换开新消息', async () => {
    await streamCommand(commandDeps, 'test-claw');
    const emit = streamMocks.onEvent!;
    emit({ ts: 1, type: 'send_content_delta', delta: '收到', trace_id: 'r1' });
    emit({ ts: 2, type: 'send_content_delta', delta: '，处理中', trace_id: 'r1' });
    emit({ ts: 3, type: 'send_content_delta', delta: '新消息', trace_id: 'r2' });

    const envelopes = stdoutEnvelopes();
    expect(envelopes).toHaveLength(3);
    expect(envelopes[0].payload.messageId).toBe('reply-r1');
    expect(envelopes[1].payload).toMatchObject({ messageId: 'reply-r1', text: '收到，处理中' });
    expect(envelopes[2].payload).toMatchObject({ messageId: 'reply-r2', text: '新消息' });
  });

  it('SIGINT：写 terminal envelope 后 exit(0)，reader.stop 一次', async () => {
    await streamCommand(commandDeps, 'test-claw');
    const handler = streamMocks.signalHandlers.SIGINT[0];
    handler();

    await vi.waitFor(() => {
      expect(stdoutEnvelopes().some(e => e.kind === 'terminal')).toBe(true);
    });
    const envelopes = stdoutEnvelopes();
    const terminal = envelopes.find(e => e.kind === 'terminal');
    expect(terminal.payload).toEqual({ reason: 'sigint' });
    expect(streamMocks.reader.stop).toHaveBeenCalledTimes(1);
  });

  it('reader 启动失败：写 error envelope（class local）后抛 CliError', async () => {
    streamMocks.reader.start.mockImplementation(() => { throw new Error('boom'); });
    await expect(streamCommand(commandDeps, 'test-claw')).rejects.toThrow(/Failed to start stream reader/);

    const envelopes = stdoutEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ kind: 'error', payload: { class: 'local' } });
  });
});

// ---------------------------------------------------------------------------
// mapper 单元语义
// ---------------------------------------------------------------------------
describe('LauncherEventMapper', () => {
  it('不映射的事件返回 null；空 delta 返回 null；无 trace_id fallback 稳定', () => {
    const mapper = new LauncherEventMapper();
    expect(mapper.map({ ts: 1, type: 'provider_info' })).toBeNull();
    expect(mapper.map({ ts: 2, type: 'text_delta', delta: '' })).toBeNull();
    const a = mapper.map({ ts: 3, type: 'text_delta', delta: 'x' });
    const b = mapper.map({ ts: 4, type: 'text_delta', delta: 'y' });
    expect(a).toEqual({ messageId: 'text-untraced', role: 'motion', text: 'x' });
    expect(b).toEqual({ messageId: 'text-untraced', role: 'motion', text: 'xy' });
  });
});
