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
import { readCurrentTurnSnapshot } from '../../src/foundation/stream/index.js';
import { sendCommand } from '../../src/cli/commands/claw-send.js';
import { streamCommand } from '../../src/cli/commands/claw-stream.js';
import { getGlobalConfigPath } from '../../src/assembly/config/global-config-path.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/index.js';
import { LauncherEventMapper } from '../../src/cli/launcher-envelope-producer.js';
import type { StreamReader } from '../../src/foundation/stream/index.js';
import {
  LAUNCHER_CAPABILITIES,
  LAUNCHER_PROTOCOL_VERSION_V2,
  createLauncherSequencer,
  makeLauncherV2Envelope,
  parseLauncherSendRequest,
  parseLauncherV2Envelope,
} from '../../src/cli-protocol/index.js';
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

vi.mock('../../src/foundation/stream/index.js', async (importOriginal) => {
  // importOriginal 保留 isContextExceededStreamError 等纯函数实现，只替换 IO 相关出口
  const actual = await importOriginal<typeof import('../../src/foundation/stream/index.js')>();
  return {
    ...actual,
    STREAM_FILE: 'stream.jsonl',
    createStreamReader: vi.fn((_fs: unknown, _file: unknown, onEvent: (event: unknown) => void) => {
      streamMocks.onEvent = onEvent;
      return streamMocks.reader as unknown as StreamReader;
    }),
    findRecentTurnStartOffset: vi.fn(() => 0),
    // phase 2003：current-turn 快照默认无活跃 turn；单测内按场景覆盖返回值
    readCurrentTurnSnapshot: vi.fn(() => ({ active: false, events: [], tailOffset: 0 })),
  };
});

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

  it('send_content_delta 同 trace 累积快照：同 messageId、sequence 连号；text_delta（LLM 裸文本）只产生活动摘要、不产生消息事件', async () => {
    await streamCommand(commandDeps, 'test-claw');
    const emit = streamMocks.onEvent!;
    emit({ ts: 1, type: 'turn_start', sources: [] });
    emit({ ts: 2, type: 'text_delta', delta: '内部思考', trace_id: 't1' });
    emit({ ts: 3, type: 'provider_info', name: 'kimi' });
    emit({ ts: 4, type: 'send_content_delta', delta: '你', trace_id: 'r1' });
    emit({ ts: 5, type: 'send_content_delta', delta: '好', trace_id: 'r1' });
    emit({ ts: 6, type: 'send_content_delta', delta: '呀', trace_id: 'r1' });

    const envelopes = stdoutEnvelopes();
    // phase 2002：turn_start → activity(processing)；text_delta → activity(processing/text 摘要)；
    // 首个 send delta → activity(responding)（去抖后一次）+ 3 条消息 event
    expect(envelopes).toHaveLength(6);
    expect(envelopes.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const e of envelopes) {
      expect(e.protocolVersion).toBe('chestnut.launcher.v1');
      expect(e.sessionId).toBe(envelopes[0].sessionId);
    }
    expect(envelopes[0]).toMatchObject({ kind: 'activity', payload: { phase: 'processing', label: 'turn' } });
    expect(envelopes[1]).toMatchObject({ kind: 'activity', payload: { phase: 'processing', label: 'text', detail: '内部思考', traceId: 't1' } });
    expect(envelopes[2]).toMatchObject({ kind: 'activity', payload: { phase: 'responding', traceId: 'r1' } });
    const events = envelopes.filter(e => e.kind === 'event');
    expect(events).toHaveLength(3); // text_delta 不产生消息事件
    expect(events[0].payload).toEqual({ messageId: 'reply-r1', role: 'motion', text: '你' });
    expect(events[1].payload).toEqual({ messageId: 'reply-r1', role: 'motion', text: '你好' });
    expect(events[2].payload).toEqual({ messageId: 'reply-r1', role: 'motion', text: '你好呀' });
  });

  it('send_content_delta 映射为 reply- 前缀消息；trace 切换开新消息；同 trace responding 去抖、跨 trace 放行', async () => {
    await streamCommand(commandDeps, 'test-claw');
    const emit = streamMocks.onEvent!;
    emit({ ts: 1, type: 'send_content_delta', delta: '收到', trace_id: 'r1' });
    emit({ ts: 2, type: 'send_content_delta', delta: '，处理中', trace_id: 'r1' });
    emit({ ts: 3, type: 'send_content_delta', delta: '新消息', trace_id: 'r2' });

    const envelopes = stdoutEnvelopes();
    expect(envelopes).toHaveLength(5);
    const activities = envelopes.filter(e => e.kind === 'activity');
    // phase 2002：traceId 计入去抖 key——r1 连续 delta 去抖一次；r2 是新 send 块，状态变化放行
    expect(activities).toHaveLength(2);
    expect(activities[0].payload).toMatchObject({ phase: 'responding', traceId: 'r1' });
    expect(activities[1].payload).toMatchObject({ phase: 'responding', traceId: 'r2' });
    const events = envelopes.filter(e => e.kind === 'event');
    expect(events[0].payload.messageId).toBe('reply-r1');
    expect(events[1].payload).toMatchObject({ messageId: 'reply-r1', text: '收到，处理中' });
    expect(events[2].payload).toMatchObject({ messageId: 'reply-r2', text: '新消息' });
  });

  it('activity 生命周期：processing(累计摘要)→responding→send_content_end 不清除→turn_end 才 idle', async () => {
    await streamCommand(commandDeps, 'test-claw');
    const emit = streamMocks.onEvent!;
    emit({ ts: 1, type: 'turn_start', sources: [] });
    emit({ ts: 2, type: 'thinking_delta', delta: '先想\n第一步', trace_id: 't1' });
    emit({ ts: 3, type: 'thinking_delta', delta: '再验证', trace_id: 't1' });
    emit({ ts: 4, type: 'tool_call', name: 'search', tool_use_id: 'tu1', trace_id: 't1' });
    emit({ ts: 5, type: 'tool_use_input', name: 'search', tool_use_id: 'tu1', input: { query: '不应泄漏的完整参数' }, trace_id: 't1' });
    emit({ ts: 6, type: 'tool_result', name: 'search', tool_use_id: 'tu1', success: true, summary: 'ok', step: 1, maxSteps: 10, trace_id: 't1' });
    emit({ ts: 7, type: 'send_content_delta', delta: '收到', trace_id: 'r1' });
    emit({ ts: 8, type: 'send_content_end', trace_id: 'r1' });
    emit({ ts: 9, type: 'turn_end', trace_id: 't1' });

    const envelopes = stdoutEnvelopes();
    const activities = envelopes.filter(e => e.kind === 'activity');
    // turn → thinking(摘要) → thinking(累计摘要) → tool → tool(去抖：tool_use_input 同 label+detail 跳过)
    // → tool_result → responding → send_content_end 仍 responding（去抖跳过）→ idle
    expect(activities.map(a => a.payload)).toEqual([
      { phase: 'processing', label: 'turn' },
      { phase: 'processing', label: 'thinking', detail: '先想 第一步', traceId: 't1' },
      { phase: 'processing', label: 'thinking', detail: '先想 第一步再验证', traceId: 't1' },
      { phase: 'processing', label: 'tool', detail: 'search', traceId: 't1' },
      { phase: 'processing', label: 'tool_result', detail: 'search', traceId: 't1' },
      { phase: 'responding', traceId: 'r1' },
      { phase: 'idle', traceId: 't1' },
    ]);
    // sequence 严格连号（activity 与 event 共享序号序列）
    expect(envelopes.map(e => e.sequence)).toEqual(envelopes.map((_, i) => i + 1));
    // 防泄漏：activity payload 不含工具 input；thinking 摘要为单行净化+截断
    for (const a of activities) {
      expect(JSON.stringify(a.payload)).not.toContain('不应泄漏');
      expect(a.payload).not.toHaveProperty('input');
      if (typeof a.payload.detail === 'string') expect(a.payload.detail.length).toBeLessThanOrEqual(240);
    }
  });

  it('turn_error 产生 error activity（保留可读错误行，不伪装 idle）；下一 turn 正常恢复', async () => {
    await streamCommand(commandDeps, 'test-claw');
    const emit = streamMocks.onEvent!;
    emit({ ts: 1, type: 'turn_start', sources: [] });
    emit({ ts: 2, type: 'provider_failed', provider: 'kimi', model: 'k2', error: '网络超时', trace_id: 't1' });
    emit({ ts: 3, type: 'turn_error', error: 'LLM 网络失败\nprovider kimi 不可用', trace_id: 't1' });
    emit({ ts: 4, type: 'turn_start', sources: [], trace_id: 't2' });
    emit({ ts: 5, type: 'turn_end', trace_id: 't2' });

    const activities = stdoutEnvelopes().filter(e => e.kind === 'activity');
    expect(activities.map(a => a.payload)).toEqual([
      { phase: 'processing', label: 'turn' },
      { phase: 'processing', label: 'provider', detail: 'kimi', traceId: 't1' },
      // phase 2003 Step E：error detail = claw bar 共享 formatter 输出（[claw] ✗ 摘要）
      // phase 2003 Step F：错误族携带 sinceMs（事件 ts，duration 统一时间原点）
      { phase: 'error', label: 'turn', detail: '[test-claw] ✗ LLM 网络失败 provider kimi 不可用', sinceMs: 3, traceId: 't1' },
      { phase: 'processing', label: 'turn', traceId: 't2' },
      { phase: 'idle', traceId: 't2' },
    ]);
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

  // phase 2003：current-turn 重开语义
  it('current-turn 活跃 turn：只发射压缩快照（每 trace 最终文本 + 最新 activity），reader 从 tailOffset 继续且不重复', async () => {
    const snapshotEvents = [
      { ts: 1, type: 'turn_start', trace_id: 't1' },
      { ts: 2, type: 'thinking_delta', delta: '先想', trace_id: 't1' },
      { ts: 3, type: 'thinking_delta', delta: '再验证', trace_id: 't1' },
      { ts: 4, type: 'send_content_delta', delta: '你', trace_id: 'r1' },
      { ts: 5, type: 'send_content_delta', delta: '好', trace_id: 'r1' },
      { ts: 6, type: 'send_content_delta', delta: '新块', trace_id: 'r2' },
      { ts: 7, type: 'send_content_end', trace_id: 'r2' },
    ];
    vi.mocked(readCurrentTurnSnapshot).mockReturnValue({ active: true, events: snapshotEvents as never, tailOffset: 4096 });

    await streamCommand(commandDeps, 'test-claw', { startMode: { kind: 'current-turn' } });
    // reader 必须从快照字节边界启动
    expect(streamMocks.reader.start).toHaveBeenCalledWith(4096);

    const before = stdoutEnvelopes();
    // 快照：2 条消息（r1 最终「你好」、r2「新块」）+ 1 条最新 activity（responding）；无逐条历史 delta
    expect(before.map(e => e.kind)).toEqual(['event', 'event', 'activity']);
    expect(before[0].payload).toEqual({ messageId: 'reply-r1', role: 'motion', text: '你好' });
    expect(before[1].payload).toEqual({ messageId: 'reply-r2', role: 'motion', text: '新块' });
    expect(before[2].payload).toMatchObject({ phase: 'responding' });
    expect(before.map(e => e.sequence)).toEqual([1, 2, 3]);

    // 重开后追加事件只出现一次，sequence 连续；
    // live delta 属 r1（快照最后 activity 是 r2 的 responding）→ trace 变化放行一条 responding
    streamMocks.onEvent!({ ts: 8, type: 'send_content_delta', delta: '呀', trace_id: 'r1' });
    const after = stdoutEnvelopes();
    expect(after).toHaveLength(5);
    expect(after[3]).toMatchObject({ kind: 'activity', sequence: 4, payload: { phase: 'responding', traceId: 'r1' } });
    expect(after[4]).toMatchObject({ kind: 'event', sequence: 5, payload: { messageId: 'reply-r1', text: '你好呀' } });
    // mapper 缓冲被快照 seed：live delta 继续累计而不是重新开始
  });

  it('current-turn 已结束 turn：零历史事件，reader 直接从边界 tail', async () => {
    vi.mocked(readCurrentTurnSnapshot).mockReturnValue({ active: false, events: [], tailOffset: 2048 });
    await streamCommand(commandDeps, 'test-claw', { startMode: { kind: 'current-turn' } });
    expect(streamMocks.reader.start).toHaveBeenCalledWith(2048);
    expect(stdoutEnvelopes()).toHaveLength(0);

    streamMocks.onEvent!({ ts: 1, type: 'turn_start', trace_id: 't9' });
    const envelopes = stdoutEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ kind: 'activity', sequence: 1, payload: { phase: 'processing', label: 'turn', traceId: 't9' } });
  });

  it('current-turn 快照 activity 与首个 live 事件去抖（状态未变不重复发射）', async () => {
    const snapshotEvents = [
      { ts: 1, type: 'turn_start', trace_id: 't1' },
      { ts: 2, type: 'send_content_delta', delta: '你好', trace_id: 'r1' },
    ];
    vi.mocked(readCurrentTurnSnapshot).mockReturnValue({ active: true, events: snapshotEvents as never, tailOffset: 1024 });
    await streamCommand(commandDeps, 'test-claw', { startMode: { kind: 'current-turn' } });

    // live 首个事件仍是同 trace 的 send delta：responding activity 与快照相同 → 去抖不重复发
    streamMocks.onEvent!({ ts: 3, type: 'send_content_delta', delta: '！', trace_id: 'r1' });
    const envelopes = stdoutEnvelopes();
    const activities = envelopes.filter(e => e.kind === 'activity');
    expect(activities).toHaveLength(1); // 只有快照那一条
    expect(envelopes[envelopes.length - 1]).toMatchObject({ kind: 'event', payload: { text: '你好！' } });
  });
});

// ---------------------------------------------------------------------------
// mapper 单元语义
// ---------------------------------------------------------------------------
describe('LauncherEventMapper', () => {
  it('不映射的事件（含 text_delta 裸文本）返回 null；空 delta 返回 null；无 trace_id fallback 稳定', () => {
    const mapper = new LauncherEventMapper();
    expect(mapper.map({ ts: 1, type: 'provider_info' })).toBeNull();
    expect(mapper.map({ ts: 2, type: 'text_delta', delta: '内部思考' })).toBeNull();
    expect(mapper.map({ ts: 3, type: 'send_content_delta', delta: '' })).toBeNull();
    const a = mapper.map({ ts: 4, type: 'send_content_delta', delta: 'x' });
    const b = mapper.map({ ts: 5, type: 'send_content_delta', delta: 'y' });
    expect(a).toEqual({ messageId: 'reply-untraced', role: 'motion', text: 'x' });
    expect(b).toEqual({ messageId: 'reply-untraced', role: 'motion', text: 'xy' });
  });

  it('交错 trace 各自独立累积（phase 2000 实机：真实 stream 两块 A,B,A,B 交错，单缓冲会把每块冲成最后一段）', () => {
    const mapper = new LauncherEventMapper();
    expect(mapper.map({ ts: 1, type: 'send_content_delta', delta: '甲一', trace_id: 'A' }))
      .toEqual({ messageId: 'reply-A', role: 'motion', text: '甲一' });
    expect(mapper.map({ ts: 2, type: 'send_content_delta', delta: '乙一', trace_id: 'B' }))
      .toEqual({ messageId: 'reply-B', role: 'motion', text: '乙一' });
    // 交错返回 A：不得清空 A 的已有缓冲
    expect(mapper.map({ ts: 3, type: 'send_content_delta', delta: '甲二', trace_id: 'A' }))
      .toEqual({ messageId: 'reply-A', role: 'motion', text: '甲一甲二' });
    expect(mapper.map({ ts: 4, type: 'send_content_delta', delta: '乙二', trace_id: 'B' }))
      .toEqual({ messageId: 'reply-B', role: 'motion', text: '乙一乙二' });
  });
});


describe('launcher.v2 protocol', () => {
  it('uses a versioned frame and monotonic sequence without sessionId', () => {
    const next = createLauncherSequencer();
    const first = makeLauncherV2Envelope(next(), 'daemon', { state: 'stopped' });
    const second = makeLauncherV2Envelope(next(), 'terminal', { reason: 'stopped' });
    expect(first).toEqual({ protocol: LAUNCHER_PROTOCOL_VERSION_V2, kind: 'daemon', sequence: 1, payload: { state: 'stopped' } });
    expect(second.sequence).toBe(2);
    expect(first).not.toHaveProperty('sessionId');
  });

  it('preserves unknown kinds and rejects version mismatches', () => {
    const unknown = parseLauncherV2Envelope(JSON.stringify({
      protocol: LAUNCHER_PROTOCOL_VERSION_V2, sequence: 8, kind: 'future_event', payload: { safe: true },
    }));
    expect(unknown).toMatchObject({ kind: 'unknown:future_event', rawKind: 'future_event', sequence: 8 });
    expect(() => parseLauncherV2Envelope(JSON.stringify({
      protocol: 'chestnut.launcher.v1', sequence: 1, kind: 'event', payload: {},
    }))).toThrow(/unsupported/);
  });

  it('validates command input and advertises capabilities', () => {
    expect(parseLauncherSendRequest('{"requestId":"r1","text":"ping"}')).toEqual({ requestId: 'r1', text: 'ping' });
    expect(() => parseLauncherSendRequest('{"requestId":"r1","text":" "}')).toThrow(/text/);
    expect(LAUNCHER_CAPABILITIES).toMatchObject({
      protocol: LAUNCHER_PROTOCOL_VERSION_V2,
      commands: ['status', 'setup', 'start', 'send', 'stream'],
    });
  });
});
