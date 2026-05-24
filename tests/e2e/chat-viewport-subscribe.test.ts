import { describe, it, expect, afterEach } from 'vitest';
import { promises as nativeFs } from 'node:fs';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createDirContext } from '../../src/cli/utils/factories.js';
import { createStreamReader, STREAM_FILE, type StreamEvent, type StreamReader } from '../../src/foundation/stream/index.js';
import { makeAudit } from '../helpers/audit.js';
import { waitFor } from '../helpers/wait-for.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/cli/commands/viewport-audit-events.js';
import { STREAM_AUDIT_EVENTS } from '../../src/foundation/stream/audit-events.js';
import { createMainTurnUI, createTaskEventHandler, type MainTurnUIController } from '../../src/cli/commands/chat-viewport.js';

async function appendJsonl(p: string, ev: object) {
  await nativeFs.appendFile(p, JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
}

function dispatchMainEvent(ev: StreamEvent, mainUI: MainTurnUIController) {
  switch (ev.type) {
    case 'turn_start':
    case 'llm_start':
      mainUI.flushThinking();
      mainUI.flushStreaming();
      mainUI.enterPhase('waiting_llm');
      mainUI.clearPreview();
      break;
    case 'text_delta': {
      mainUI.flushThinking();
      mainUI.enterPhase('streaming_text');
      const buf = mainUI.appendToBuffer((ev as Record<string, unknown>).delta as string);
      const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
      const indent = '  ';
      const preview = (buf + '▋')
        .split('\n')
        .map((line, i) => (i === 0 ? dotPrefix : indent) + line)
        .join('\n');
      mainUI.setPreview(preview);
      break;
    }
    case 'turn_end':
      mainUI.enterPhase('idle');
      mainUI.flushStreaming();
      mainUI.clearPreview();
      break;
  }
}

// phase161 subscribe 回归：it 1（事件触达 handleEvent）已迁入 tests/e2e/chat-viewport-regression.test.ts
// （Step 9 骨架 + Step 10-15 基线集合提供等价覆盖；phase165 Step 16 删除）
// 本 describe 保留 it 2（STREAM_READER_FILE_MISSING 防线）
describe('chat-viewport 订阅 motion stream（phase161 回归）', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      try { await cleanups.pop()!(); } catch {}
    }
  });

  it('baseDir 指向不含 stream.jsonl 的目录时，audit 写入 stream_reader_file_missing', async () => {
    const wrongDir = await createTempDir('phase161-wrong-');
    cleanups.push(() => cleanupTempDir(wrongDir));

    const { fs } = createDirContext(wrongDir);
    const { audit, events } = makeAudit();
    const reader = createStreamReader(fs, STREAM_FILE, () => {}, audit);
    cleanups.push(() => reader.stop());

    reader.start();
    // start() 内的 existsSync 探测是同步的（Step 1 §7.b 论证），无需 waitFor

    expect(events.some(e => e[0] === STREAM_AUDIT_EVENTS.READER_FILE_MISSING)).toBe(true);
  });
});

describe('chat-viewport 主 UI 隔离（phase162）', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      try { await cleanups.pop()!(); } catch {}
    }
  });

  it('主 turn 中途触发 subagent，主 turn text_delta 不被 task 事件清空', async () => {
    const { audit } = makeAudit();

    const mainUI = createMainTurnUI({
      appendOutput: () => {},
      updateDisplay: () => {},
      trimOutputNewlines: false,
      getThinkingMode: () => 'full',
      audit,
    });

    const mockTaskStatusBar = { updateTrack: () => {}, removeTrack: () => {} };
    const taskHandler = createTaskEventHandler({
      stopTaskWatch: () => {},
      taskStatusBar: mockTaskStatusBar as any,
    });

    // 主 stream 发 turn_start/llm_start/text_delta "hello"
    mainUI.withScope('main', () => {
      dispatchMainEvent({ type: 'turn_start' }, mainUI);
      dispatchMainEvent({ type: 'llm_start' }, mainUI);
      dispatchMainEvent({ type: 'text_delta', delta: 'hello' }, mainUI);
    });
    const previewBefore = mainUI.getPreview();
    expect(previewBefore).toContain('hello');

    // task stream 发 tool_call/tool_result/turn_end（subagent 活动）
    mainUI.withScope('task', () => {
      taskHandler('task-x', { type: 'tool_call', name: 'read_file' });
      taskHandler('task-x', { type: 'tool_result', success: true, step: 1, maxSteps: 3, summary: 'ok' });
      taskHandler('task-x', { type: 'turn_end' });
    });

    // 关键断言：task 事件过后主 preview 不被清空
    expect(mainUI.getPreview()).toContain('hello');

    // 主 stream 继续
    mainUI.withScope('main', () => {
      dispatchMainEvent({ type: 'text_delta', delta: ' world' }, mainUI);
      dispatchMainEvent({ type: 'turn_end' }, mainUI);
    });

    // turn_end 后 preview 清空（正常）
    expect(mainUI.getPreview()).toBe('');
  });

  it('并发场景 audit 无 viewport_ui_cross_pollution', async () => {
    const agentDir = await createTempDir('phase162-audit-');
    cleanups.push(() => cleanupTempDir(agentDir));

    const taskId = 'task-audit';
    const taskDir = path.join(agentDir, 'tasks', 'queues', 'results', taskId);
    await nativeFs.mkdir(taskDir, { recursive: true });

    const mainStreamPath = path.join(agentDir, STREAM_FILE);
    const taskStreamPath = path.join(taskDir, STREAM_FILE);
    await nativeFs.writeFile(mainStreamPath, '');
    await nativeFs.writeFile(taskStreamPath, '');

    const { fs: mainFs } = createDirContext(agentDir);
    const { fs: taskFs } = createDirContext(taskDir);
    const { audit, events } = makeAudit();

    const mainUI = createMainTurnUI({
      appendOutput: () => {},
      updateDisplay: () => {},
      trimOutputNewlines: false,
      getThinkingMode: () => 'full',
      audit,
    });

    const mockTaskStatusBar2 = { updateTrack: () => {}, removeTrack: () => {} };
    const taskHandler = createTaskEventHandler({
      stopTaskWatch: () => {},
      taskStatusBar: mockTaskStatusBar2 as any,
    });

    const mainReader = createStreamReader(mainFs, STREAM_FILE,
      (ev) => mainUI.withScope('main', () => dispatchMainEvent(ev, mainUI)),
      audit);
    const taskReader = createStreamReader(taskFs, STREAM_FILE,
      (ev) => mainUI.withScope('task', () => taskHandler(taskId, ev)),
      audit);
    cleanups.push(() => mainReader.stop());
    cleanups.push(() => taskReader.stop());
    mainReader.start();
    taskReader.start();

    await new Promise(r => setTimeout(r, 300)); // sleep: let stream reader start and settle

    await appendJsonl(mainStreamPath, { type: 'turn_start' });
    await appendJsonl(mainStreamPath, { type: 'llm_start' });
    await appendJsonl(mainStreamPath, { type: 'text_delta', delta: 'hello' });
    await appendJsonl(taskStreamPath, { type: 'tool_call', name: 'read_file' });
    await appendJsonl(taskStreamPath, { type: 'tool_result', success: true, step: 1, maxSteps: 3, summary: 'ok' });
    await appendJsonl(taskStreamPath, { type: 'turn_end' });
    await appendJsonl(mainStreamPath, { type: 'text_delta', delta: ' world' });
    await appendJsonl(mainStreamPath, { type: 'turn_end' });
    await new Promise(r => setTimeout(r, 300)); // sleep: let events propagate before assertion

    const crossPollution = events.filter(e => e[0] === VIEWPORT_AUDIT_EVENTS.UI_CROSS_POLLUTION);
    expect(crossPollution).toHaveLength(0);
  });

  it('task scope 内直接写主 UI 会 audit cross_pollution（反向咬合）', () => {
    const { audit, events } = makeAudit();
    const mainUI = createMainTurnUI({
      appendOutput: () => {},
      updateDisplay: () => {},
      trimOutputNewlines: false,
      getThinkingMode: () => 'full',
      audit,
    });

    mainUI.withScope('task', () => mainUI.setPreview('leaked'));
    const crossPollution = events.filter(e => e[0] === VIEWPORT_AUDIT_EVENTS.UI_CROSS_POLLUTION);
    expect(crossPollution).toHaveLength(1);
    expect(crossPollution[0][1]).toBe('method=setPreview');
    expect(crossPollution[0][2]).toBe('source=task');
  });

  it('TaskEventHandlerDeps 不含 MainTurnUIController（tsc 层隔离）', () => {
    // 运行时类型断言
    type HasMainUI = 'mainUI' extends keyof import('../../src/cli/commands/chat-viewport.js').TaskEventHandlerDeps ? true : false;
    const _check: HasMainUI = false;
    expect(_check).toBe(false);

    // @ts-expect-error TaskEventHandlerDeps should not accept MainTurnUIController
    const _bad: import('../../src/cli/commands/chat-viewport.js').TaskEventHandlerDeps = {
      getTaskWatch: () => undefined,
      showRecapStream: () => false,
      appendOutput: () => {},
      stopTaskWatch: () => {},
      mainUI: {} as MainTurnUIController,
    };
    void _bad;
  });
});


describe('chat-viewport 主 UI 并发隔离（phase162 streamReader）', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      try { await cleanups.pop()!(); } catch {}
    }
  });

  it('主 turn 中途触发 subagent，主 text_delta 不被 task 事件清空', async () => {
    const agentDir = await createTempDir('phase162-concurrent-');
    cleanups.push(() => cleanupTempDir(agentDir));

    const taskId = 'task-concurrent';
    const taskDir = path.join(agentDir, 'tasks', 'queues', 'results', taskId);
    await nativeFs.mkdir(taskDir, { recursive: true });

    const mainStreamPath = path.join(agentDir, STREAM_FILE);
    const taskStreamPath = path.join(taskDir, STREAM_FILE);
    await nativeFs.writeFile(mainStreamPath, '');
    await nativeFs.writeFile(taskStreamPath, '');

    const { fs: mainFs } = createDirContext(agentDir);
    const { fs: taskFs } = createDirContext(taskDir);
    const { audit, events } = makeAudit();

    const mainUI = createMainTurnUI({
      appendOutput: () => {},
      updateDisplay: () => {},
      trimOutputNewlines: false,
      getThinkingMode: () => 'full',
      audit,
    });

    const taskStatusBarCalls: Array<{ taskId: string; event: unknown }> = [];
    const mockTaskStatusBar3 = {
      updateTrack: (tid: string, ev: unknown) => { taskStatusBarCalls.push({ taskId: tid, event: ev }); },
      removeTrack: () => {},
    };
    const taskHandler = createTaskEventHandler({
      stopTaskWatch: () => {},
      taskStatusBar: mockTaskStatusBar3 as any,
    });

    const mainReader = createStreamReader(
      mainFs, STREAM_FILE,
      (ev) => {
        if (ev.type === 'text_delta') {
          mainUI.flushThinking();
          mainUI.enterPhase('streaming_text');
          const buf = mainUI.appendToBuffer((ev as Record<string, unknown>).delta as string);
          mainUI.setPreview(buf);
        }
      },
      audit,
    );
    const taskReader = createStreamReader(
      taskFs, STREAM_FILE,
      (ev) => {
        taskHandler(taskId, ev);
      },
      audit,
    );
    cleanups.push(() => mainReader.stop());
    cleanups.push(() => taskReader.stop());
    mainReader.start();
    taskReader.start();
    await new Promise(r => setTimeout(r, 300)); // sleep: let stream reader start and settle

    // NOTE: chokidar 对快速连续 append 会合并/丢弃 FS 事件——必须在 append 间插入间隔，
    // 让 createStreamReader 的 watcher 能逐条捕获。这是 chokidar 已知行为，不是 reader 的 bug。
    const EVENT_GAP_MS = 150;
    const appendJsonl = async (p: string, ev: object) => {
      await nativeFs.appendFile(p, JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
      await new Promise(r => setTimeout(r, EVENT_GAP_MS));
    };

    // 主 stream：turn_start → llm_start → text_delta "hello"
    await appendJsonl(mainStreamPath, { type: 'turn_start' });
    await appendJsonl(mainStreamPath, { type: 'llm_start' });
    await appendJsonl(mainStreamPath, { type: 'text_delta', delta: 'hello' });
    await waitFor(() => mainUI.getPreview().includes('hello'), 10000);
    expect(mainUI.getPreview()).toContain('hello');

    // task stream：tool_call → tool_result → turn_end（subagent 活动）
    await appendJsonl(taskStreamPath, { type: 'tool_call', name: 'read_file' });
    await appendJsonl(taskStreamPath, { type: 'tool_result', success: true, step: 1, maxSteps: 3, summary: 'ok' });
    await appendJsonl(taskStreamPath, { type: 'turn_end' });
    await waitFor(() => taskStatusBarCalls.length >= 2, 10000);

    // 关键断言：task 事件过后主 preview 不被清空
    expect(mainUI.getPreview()).toContain('hello');

    // 正常路径不触发 cross_pollution audit
    const crossPollution = events.filter(e => e[0] === VIEWPORT_AUDIT_EVENTS.UI_CROSS_POLLUTION);
    expect(crossPollution).toHaveLength(0);
  });
});
