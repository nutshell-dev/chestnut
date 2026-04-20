import { describe, it, expect, afterEach } from 'vitest';
import { promises as nativeFs } from 'node:fs';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createDirContext } from '../../src/cli/cli-factories.js';
import { createStreamReader, STREAM_FILE, type StreamEvent, type StreamReader } from '../../src/foundation/stream/index.js';
import { makeAudit } from '../helpers/audit.js';
import { AUDIT_EVENTS } from '../../src/foundation/audit/events.js';
import { createMainTurnUI, createTaskEventHandler, type MainTurnUIController } from '../../src/cli/commands/chat-viewport.js';

const TIMEOUT_MS = 10000;

function waitFor(condition: () => boolean, timeoutMs = TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try { if (condition()) { resolve(); return; } } catch {}
      if (Date.now() - start > timeoutMs) { reject(new Error('waitFor timed out')); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function appendJsonl(p: string, ev: object) {
  await nativeFs.appendFile(p, JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
}

function dispatchMainEvent(ev: StreamEvent, mainUI: MainTurnUIController) {
  switch (ev.type) {
    case 'turn_start':
    case 'llm_start':
      mainUI.flushThinking();
      mainUI.flushStreaming();
      break;
    case 'text_delta': {
      mainUI.stopSpinner();
      const buf = mainUI.appendToBuffer((ev as Record<string, unknown>).delta as string);
      const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
      const indent = '  ';
      const preview = (buf + '▋')
        .split('\n')
        .map((line, i) => (i === 0 ? dotPrefix : indent) + line)
        .join('\n');
      mainUI.setSuffix(preview);
      break;
    }
    case 'turn_end':
      mainUI.stopSpinner();
      mainUI.flushStreaming();
      mainUI.clearSuffix();
      break;
  }
}

describe('chat-viewport 订阅 motion stream（phase161 回归）', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      try { await cleanups.pop()!(); } catch {}
    }
  });

  it('agent dir 下的 stream.jsonl 事件能触达 handleEvent', async () => {
    const agentDir = await createTempDir('phase161-agent-');
    cleanups.push(() => cleanupTempDir(agentDir));

    // 预创建空 stream.jsonl
    const streamPath = path.join(agentDir, STREAM_FILE);
    await nativeFs.writeFile(streamPath, '');

    const received: StreamEvent[] = [];
    // 模拟 chat-viewport L64 + L471 修复后的订阅形态
    const { fs } = createDirContext(agentDir);
    const reader: StreamReader = createStreamReader(
      fs,
      STREAM_FILE,
      (ev) => received.push(ev),
      makeAudit().audit,
    );
    cleanups.push(() => reader.stop());
    reader.start();

    // chokidar 启动期
    await new Promise(r => setTimeout(r, 300));

    // 模拟 agent 写事件
    await nativeFs.appendFile(
      streamPath,
      JSON.stringify({ ts: Date.now(), type: 'text_delta', delta: 'hi' }) + '\n',
    );

    await waitFor(() => received.length >= 1);
    expect(received[0].type).toBe('text_delta');
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

    expect(events.some(e => e[0] === AUDIT_EVENTS.STREAM_READER_FILE_MISSING)).toBe(true);
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

    const taskHandler = createTaskEventHandler({
      getTaskWatch: () => ({ silent: false }),
      showRecapStream: () => true,
      appendOutput: () => {},
      stopTaskWatch: () => {},
    });

    // 主 stream 发 turn_start/llm_start/text_delta "hello"
    mainUI.withScope('main', () => {
      dispatchMainEvent({ type: 'turn_start' }, mainUI);
      dispatchMainEvent({ type: 'llm_start' }, mainUI);
      dispatchMainEvent({ type: 'text_delta', delta: 'hello' }, mainUI);
    });
    const suffixBefore = mainUI.getSuffix();
    expect(suffixBefore).toContain('hello');

    // task stream 发 tool_call/tool_result/turn_end（subagent 活动）
    mainUI.withScope('task', () => {
      taskHandler('task-x', 'subagent', { type: 'tool_call', name: 'read_file' });
      taskHandler('task-x', 'subagent', { type: 'tool_result', success: true, step: 1, maxSteps: 3, summary: 'ok' });
      taskHandler('task-x', 'subagent', { type: 'turn_end' });
    });

    // 关键断言：task 事件过后主 suffix 不被清空
    expect(mainUI.getSuffix()).toContain('hello');

    // 主 stream 继续
    mainUI.withScope('main', () => {
      dispatchMainEvent({ type: 'text_delta', delta: ' world' }, mainUI);
      dispatchMainEvent({ type: 'turn_end' }, mainUI);
    });

    // turn_end 后 suffix 清空（正常）
    expect(mainUI.getSuffix()).toBe('');
  });

  it('并发场景 audit 无 viewport_ui_cross_pollution', async () => {
    const agentDir = await createTempDir('phase162-audit-');
    cleanups.push(() => cleanupTempDir(agentDir));

    const taskId = 'task-audit';
    const taskDir = path.join(agentDir, 'tasks', 'results', taskId);
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

    const taskHandler = createTaskEventHandler({
      getTaskWatch: () => ({ silent: false }),
      showRecapStream: () => true,
      appendOutput: () => {},
      stopTaskWatch: () => {},
    });

    const mainReader = createStreamReader(mainFs, STREAM_FILE,
      (ev) => mainUI.withScope('main', () => dispatchMainEvent(ev, mainUI)),
      audit);
    const taskReader = createStreamReader(taskFs, STREAM_FILE,
      (ev) => mainUI.withScope('task', () => taskHandler(taskId, 'subagent', ev)),
      audit);
    cleanups.push(() => mainReader.stop());
    cleanups.push(() => taskReader.stop());
    mainReader.start();
    taskReader.start();

    await new Promise(r => setTimeout(r, 300));

    await appendJsonl(mainStreamPath, { type: 'turn_start' });
    await appendJsonl(mainStreamPath, { type: 'llm_start' });
    await appendJsonl(mainStreamPath, { type: 'text_delta', delta: 'hello' });
    await appendJsonl(taskStreamPath, { type: 'tool_call', name: 'read_file' });
    await appendJsonl(taskStreamPath, { type: 'tool_result', success: true, step: 1, maxSteps: 3, summary: 'ok' });
    await appendJsonl(taskStreamPath, { type: 'turn_end' });
    await appendJsonl(mainStreamPath, { type: 'text_delta', delta: ' world' });
    await appendJsonl(mainStreamPath, { type: 'turn_end' });
    await new Promise(r => setTimeout(r, 300));

    const crossPollution = events.filter(e => e[0] === AUDIT_EVENTS.VIEWPORT_UI_CROSS_POLLUTION);
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

    mainUI.withScope('task', () => mainUI.setSuffix('leaked'));
    const crossPollution = events.filter(e => e[0] === AUDIT_EVENTS.VIEWPORT_UI_CROSS_POLLUTION);
    expect(crossPollution).toHaveLength(1);
    expect(crossPollution[0][1]).toBe('setSuffix');
    expect(crossPollution[0][2]).toBe('task');
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
    const taskDir = path.join(agentDir, 'tasks', 'results', taskId);
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

    const taskAppended: string[] = [];
    const taskHandler = createTaskEventHandler({
      getTaskWatch: () => ({ silent: false }),
      showRecapStream: () => true,
      appendOutput: (_color, text) => { taskAppended.push(text); },
      stopTaskWatch: () => {},
    });

    const mainReader = createStreamReader(
      mainFs, STREAM_FILE,
      (ev) => {
        if (ev.type === 'text_delta') {
          mainUI.stopSpinner();
          const buf = mainUI.appendToBuffer((ev as Record<string, unknown>).delta as string);
          mainUI.setSuffix(buf);
        }
      },
      audit,
    );
    const taskReader = createStreamReader(
      taskFs, STREAM_FILE,
      (ev) => {
        taskHandler(taskId, 'subagent', ev);
      },
      audit,
    );
    cleanups.push(() => mainReader.stop());
    cleanups.push(() => taskReader.stop());
    mainReader.start();
    taskReader.start();
    await new Promise(r => setTimeout(r, 300));

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
    await waitFor(() => mainUI.getSuffix().includes('hello'));
    expect(mainUI.getSuffix()).toContain('hello');

    // task stream：tool_call → tool_result → turn_end（subagent 活动）
    await appendJsonl(taskStreamPath, { type: 'tool_call', name: 'read_file' });
    await appendJsonl(taskStreamPath, { type: 'tool_result', success: true, step: 1, maxSteps: 3, summary: 'ok' });
    await appendJsonl(taskStreamPath, { type: 'turn_end' });
    await waitFor(() => taskAppended.length >= 2);

    // 关键断言：task 事件过后主 suffix 不被清空
    expect(mainUI.getSuffix()).toContain('hello');

    // 正常路径不触发 cross_pollution audit
    const crossPollution = events.filter(e => e[0] === AUDIT_EVENTS.VIEWPORT_UI_CROSS_POLLUTION);
    expect(crossPollution).toHaveLength(0);
  });
});
