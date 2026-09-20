/**
 * chat-viewport tests
 *
 * Step 5: bufferType 未赋值 'text'
 * Step 6: daemon 死亡 / ESC 5s 超时时未 flush streaming/thinking buffer
 *
 * 测试策略：源代码结构验证（不依赖复杂 TUI mock）
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createMainTurnUI } from '../../src/viewport/chat-viewport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewportPath = path.join(__dirname, '../../src/viewport/chat-viewport.ts');
const mainTurnUIPath = path.join(__dirname, '../../src/viewport/main-turn-ui.ts');
const clawLinePath = path.join(__dirname, '../../src/viewport/chat-viewport-claw-line.ts');
const taskEventsPath = path.join(__dirname, '../../src/viewport/chat-viewport-task-events.ts');
const clawManagerPath = path.join(__dirname, '../../src/viewport/chat-viewport-claw-manager.ts');
const commandsPath = path.join(__dirname, '../../src/viewport/chat-viewport-commands.ts');
const turnTrackerPath = path.join(__dirname, '../../src/viewport/chat-viewport-turn-tracker.ts');
const eventHandlerPath = path.join(__dirname, '../../src/viewport/chat-viewport-event-handler.ts');
const clawPanelPath = path.join(__dirname, '../../src/viewport/chat-viewport-claw-panel.ts');
const displayPath = path.join(__dirname, '../../src/viewport/chat-viewport-display.ts');
const initPath = path.join(__dirname, '../../src/viewport/chat-viewport-init.ts');

describe('chat-viewport Phase 72', () => {
  const sourceCode = fs.readFileSync(viewportPath, 'utf-8')
    + fs.readFileSync(mainTurnUIPath, 'utf-8')
    + fs.readFileSync(clawLinePath, 'utf-8')
    + fs.readFileSync(taskEventsPath, 'utf-8')
    + fs.readFileSync(clawManagerPath, 'utf-8')
    + fs.readFileSync(commandsPath, 'utf-8')
    + fs.readFileSync(turnTrackerPath, 'utf-8')
    + fs.readFileSync(eventHandlerPath, 'utf-8')
    + fs.readFileSync(clawPanelPath, 'utf-8')
    + fs.readFileSync(displayPath, 'utf-8')
    + fs.readFileSync(initPath, 'utf-8');

  // ==========================================================================
  // Step 5: bufferType 赋值
  // ==========================================================================
  describe('Step 5: bufferType = text 赋值', () => {
    const clawManagerSource = fs.readFileSync(clawManagerPath, 'utf-8');

    it('text_delta handler 中应设置 bufferType = text', () => {
      // phase 1309: claw-manager 重构为 switch/case，从 claw-manager 源文件定位
      const startIdx = clawManagerSource.indexOf("case 'text_delta': {");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      const endIdx = clawManagerSource.indexOf('break;', startIdx);
      expect(endIdx).toBeGreaterThan(startIdx);
      const textDeltaBlock = clawManagerSource.slice(startIdx, endIdx + 6);

      // 应该在 if (track.bufferType !== 'text') 块内设置 bufferType
      expect(textDeltaBlock).toContain("track.bufferType = 'text'");
    });

    it('bufferType 赋值应在 if 块内，而非每次 delta 都赋值', () => {
      const startIdx = clawManagerSource.indexOf("case 'text_delta': {");
      const endIdx = clawManagerSource.indexOf('break;', startIdx);
      const textDeltaSection = clawManagerSource.slice(startIdx, endIdx + 6);

      // 确认有 if 检查（条件可能含额外子句如 || track.clearOnNextDelta）
      expect(textDeltaSection).toMatch(/if\s*\(track\.bufferType !== 'text'/);
      // 确认 bufferType 赋值在里面
      expect(textDeltaSection).toContain("track.bufferType = 'text'");
    });
  });

  // ==========================================================================
  // Step 6: daemon 死亡 flush
  // ==========================================================================
  describe('Step 6: daemon 死亡时 flush buffer', () => {
    it('daemon 死亡处理应调用 turnTracker.abort()', () => {
      // 找到 daemon 死亡处理逻辑
      const daemonDeadSection = sourceCode.slice(
        sourceCode.indexOf('// 进程不存在'),
        sourceCode.indexOf("appendOutput('\\x1b[31m', '✗ Daemon 已停止')")
      );
      
      expect(daemonDeadSection).toContain('turnTracker.abort()');
    });

    it('cleanupUI 应包含 flushStreaming 和 flushThinking，且 flush 在 clearPreview 之前', () => {
      const cleanupUIMatch = sourceCode.match(
        /const cleanupUI = \(\) => \{[\s\S]{0,400}?\};/
      );
      expect(cleanupUIMatch).toBeTruthy();
      const cleanupUIBlock = cleanupUIMatch![0];
      
      expect(cleanupUIBlock).toContain('mainUI.flushStreaming()');
      expect(cleanupUIBlock).toContain('mainUI.flushThinking()');

      const flushIndex = cleanupUIBlock.indexOf('mainUI.flushStreaming()');
      const clearIdx = cleanupUIBlock.indexOf('mainUI.clearPreview()');
      expect(flushIndex).toBeGreaterThan(-1);
      expect(clearIdx).toBeGreaterThan(-1);
      expect(flushIndex).toBeLessThan(clearIdx);
    });
  });

  // ==========================================================================
  // Step 6: ESC 超时 flush
  // ==========================================================================
  describe('Step 6: ESC 5s 超时 flush buffer', () => {
    it('ESC 超时回调应调用 cleanupUI', () => {
      // 找到 ESC 超时处理逻辑（5秒超时）
      const escTimeoutMatch = sourceCode.match(
        /escTimeoutId = setTimeout\(\(\) => \{[\s\S]{0,600}?\}, INTERRUPT_CLEANUP_TIMEOUT_MS\)/
      );
      expect(escTimeoutMatch).toBeTruthy();
      
      const escTimeoutBlock = escTimeoutMatch![0];
      
      expect(escTimeoutBlock).toContain('cleanupUI()');
    });
  });

  // ==========================================================================
  // Phase 72 核心重构验证
  // ==========================================================================
  describe('Phase 72 存储模型重构', () => {
    it('应使用 outputLines 而非 outputContent', () => {
      expect(sourceCode).toContain('outputLines: OutputLine[]');
      expect(sourceCode).toContain('const outputLines: OutputLine[]');
      // 不应有旧的 outputContent
      expect(sourceCode).not.toContain('let outputContent');
      expect(sourceCode).not.toContain('outputContent +=');
    });

    it('appendOutput 应使用新签名 (color, text)', () => {
      const appendOutputMatch = sourceCode.match(/const appendOutput = \([^)]+\) => \{/);
      expect(appendOutputMatch).toBeTruthy();
      expect(appendOutputMatch![0]).toContain('color: string');
      expect(appendOutputMatch![0]).toContain('text: string');
    });

    it('flushStreaming 应使用 appendOutput', () => {
      const flushStreamingMatch = sourceCode.match(
        /const flushStreaming = \(\) => \{[\s\S]{0,800}?\};/
      );
      expect(flushStreamingMatch).toBeTruthy();
      expect(flushStreamingMatch![0]).toContain('appendOutput');
      expect(flushStreamingMatch![0]).not.toContain('outputContent');
    });

    it('flushThinking 应使用 appendOutput', () => {
      const flushThinkingMatch = sourceCode.match(
        /const flushThinking = \(\) => \{[\s\S]{0,600}?\};/
      );
      expect(flushThinkingMatch).toBeTruthy();
      expect(flushThinkingMatch![0]).toContain('appendOutput');
      expect(flushThinkingMatch![0]).not.toContain('outputContent');
    });

    it('updateDisplay 应使用 fitLine 动态渲染', () => {
      const updateDisplayMatch = sourceCode.match(
        /const updateDisplay = \(\) => \{[\s\S]*?\};/
      );
      expect(updateDisplayMatch).toBeTruthy();
      expect(updateDisplayMatch![0]).toContain('fitLine');
      expect(updateDisplayMatch![0]).toContain('process.stdout.columns');
    });

    it('应有 RESIZE 监听', () => {
      expect(sourceCode).toContain("process.stdout.on('resize', onResize)");
      expect(sourceCode).toContain("process.stdout.off('resize', onResize)");
    });
  });

  // ==========================================================================
  // buildClawLine 修复验证
  // ==========================================================================
  describe('Step 3: buildClawLine 活跃路径', () => {
    it('活跃路径应使用 fitLine 而非手动 sliceFromStart', () => {
      // 找到 buildClawLine 函数
      const buildClawLineStart = sourceCode.indexOf('buildClawLine(id: string, t: ClawTrack, cols: number): string {');
      expect(buildClawLineStart).toBeGreaterThan(-1);
      
      // 取函数体前 2000 字符（足够覆盖活跃路径）
      const buildClawLineBody = sourceCode.slice(buildClawLineStart, buildClawLineStart + 2000);
      
      // 活跃路径应该使用 fitLine
      expect(buildClawLineBody).toContain('fitLine');
    });
  });

  // ==========================================================================
  // Phase 90: appendOutput 职责边界
  // ==========================================================================
  describe('Phase 90: appendOutput 职责边界', () => {
    it('appendOutput 内部不应 split text', () => {
      const appendOutputMatch = sourceCode.match(
        /const appendOutput = [^{]+\{[\s\S]{0,300}?\};/
      );
      expect(appendOutputMatch).toBeTruthy();
      // 不应有 split 循环
      expect(appendOutputMatch![0]).not.toContain('text.split');
      expect(appendOutputMatch![0]).not.toContain('for (const line of');
    });

    it('updateDisplay wrap=true 路径应先 split(\\n) 再 flatMap wrapLine', () => {
      const updateDisplayMatch = sourceCode.match(
        /const updateDisplay = \(\) => \{[\s\S]*?\};/
      );
      expect(updateDisplayMatch).toBeTruthy();
      const body = updateDisplayMatch![0];
      expect(body).toContain("split('\\n')");
      expect(body).toContain('.flatMap(');
      expect(body).toContain('wrapLine(');
    });

    it('/help appendOutput 调用应使用 wrap=true', () => {
      // 找到 help 命令区域（以可用命令列表为特征）
      const helpStart = sourceCode.indexOf("'Available commands:'");
      expect(helpStart).toBeGreaterThan(-1);
      const helpSection = sourceCode.slice(helpStart, helpStart + 500);
      // 该区域的 appendOutput 调用应有 true 参数
      expect(helpSection).toContain('lines.join(');
      expect(helpSection).toContain(', true)');
    });
  });

  // ==========================================================================
  // Phase 91: hangIndent 支持
  // ==========================================================================
  describe('Phase 91: hangIndent', () => {
    it('OutputLine 接口 含 hangIndent 字段', () => {
      expect(sourceCode).toContain('hangIndent');
    });

    it('appendOutput 签名含第四参数 hangIndent', () => {
      const match = sourceCode.match(/const appendOutput = \([^)]+\)/);
      expect(match![0]).toContain('hangIndent');
    });

    it('updateDisplay 把 hangIndent 传给 wrapLine', () => {
      expect(sourceCode).toMatch(/wrapLine\(line, cols, hangIndent\)/);
    });

    it('flushStreaming 传 hangIndent 到 appendOutput', () => {
      const flushMatch = sourceCode.match(
        /const flushStreaming[\s\S]{0,700}?appendOutput\([^)]+\)/
      );
      // 经过 prefixLines 提取后，hangIndent 直接传 '  ' 字面量，不再经过 indent 变量
      expect(flushMatch![0]).toMatch(/appendOutput\([^)]*'  '\)/);
    });

    it('flushThinking 用 prefixLines 统一缩进', () => {
      const flushMatch = sourceCode.match(
        /const flushThinking[\s\S]{0,500}?appendOutput\([^)]+\)/
      );
      // phase 1245: flushThinking 改用 prefixLines，与 flushStreaming/flushStreamingNormal 一致
      const actual = flushMatch![0];
      expect(actual).toContain('prefixLines(content,');
      expect(actual).toMatch(/appendOutput\([^)]*'  '\)/);
    });
  });

  // ==========================================================================
  // Phase 91 step5-7: 死循环修复 / 死代码清理 / indent 一致性
  // ==========================================================================
  describe('Phase 91 step5: wrapLine Math.max 防死循环', () => {
    it('wrapLine 实现中应有 Math.max(1', () => {
      const wrapLineSrc = fs.readFileSync(
        path.join(__dirname, '../../src/viewport/terminal-text.ts'), 'utf-8'
      );
      const wrapLineStart = wrapLineSrc.indexOf('export function wrapLine');
      expect(wrapLineStart).toBeGreaterThan(-1);
      const wrapLineBody = wrapLineSrc.slice(wrapLineStart, wrapLineStart + 700);
      expect(wrapLineBody).toContain('Math.max(1');
    });
  });

  describe('Phase 91 step6: 死代码已清除', () => {
    it('getClawActivityInfo 不应出现在 import 中', () => {
      expect(sourceCode).not.toContain('getClawActivityInfo');
    });

    it('ownTurnCount 不应存在', () => {
      expect(sourceCode).not.toContain('ownTurnCount');
    });

    it('ownStep 不应存在', () => {
      expect(sourceCode).not.toContain('ownStep');
    });

    it('ownMaxSteps 不应存在', () => {
      expect(sourceCode).not.toContain('ownMaxSteps');
    });
  });

  describe('Phase 91 step7: thinking_delta 不再拆分多行', () => {
    it('thinking_delta 直接用 prefix + buffer，不用 split/map 缩进', () => {
      const eventHandlerCode = fs.readFileSync(eventHandlerPath, 'utf-8');
      const tdStart = eventHandlerCode.indexOf("case 'thinking_delta':");
      expect(tdStart).toBeGreaterThan(-1);
      const tdEnd = eventHandlerCode.indexOf('break;', tdStart);
      expect(tdEnd).toBeGreaterThan(-1);
      const tdSection = eventHandlerCode.slice(tdStart, tdEnd + 6);
      expect(tdSection).toContain("prefix + thinkingBuf");
      expect(tdSection).not.toContain('.split(');
    });
  });

  describe('Phase 164 Step 8: cleanup 时序', () => {
    it('cleanup 块内 mainUI.enterPhase(idle) 在 observability.recordShutdown 之前', () => {
      const cleanupStart = sourceCode.indexOf('await exitPromise;');
      expect(cleanupStart).toBeGreaterThan(-1);
      const cleanupBlock = sourceCode.slice(cleanupStart, cleanupStart + 1500);
      const stopIdx = cleanupBlock.indexOf("mainUI.enterPhase('idle')");
      const shutIdx = cleanupBlock.indexOf('observability.recordShutdown(shutdownReason)');
      expect(stopIdx).toBeGreaterThan(-1);
      expect(shutIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeLessThan(shutIdx);
    });

    it('cleanup 块不调 observability.dispose()', () => {
      const cleanupStart = sourceCode.indexOf('await exitPromise;');
      const cleanupBlock = sourceCode.slice(cleanupStart, cleanupStart + 1500);
      expect(cleanupBlock).not.toContain('observability.dispose()');
    });
  });

  describe('Phase 798: enterPhase idempotency + min-dwell', () => {
    it('idle 无 spinner 下连续 enterPhase idle 不产 recordSpinner audit', () => {
      const calls: Array<[string, string]> = [];
      const mainUI = createMainTurnUI({
        appendOutput: () => {},
        updateDisplay: () => {},
        trimOutputNewlines: true,
        getThinkingMode: () => 'off',
        audit: { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s},
        observability: { recordSpinner: (a, t) => calls.push([a, t]) },
      });
      mainUI.enterPhase('idle');
      mainUI.enterPhase('idle');
      mainUI.enterPhase('idle');
      expect(calls).toHaveLength(0);

      mainUI.enterPhase('waiting_llm');
      mainUI.enterPhase('idle');
      // start 1 次 + stop 1 次（dwell 同步路径 if elapsed >= dwell）或 stop 0 次（推迟）
      // 至少 start 已 emit
      expect(calls.filter(c => c[0] === 'start')).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Phase 1148 Step B: 关闭 terminal focus-events 单变量隔离
  // ==========================================================================
  // ==========================================================================
  // Phase 1150 Step B: startup clawBar materialization
  // ==========================================================================
  describe('Phase 1150 Step B: startup clawBar materialization', () => {
    const viewportOnly = fs.readFileSync(viewportPath, 'utf-8');

    it('initial rescan 后同步调用 clawPanel.materializeNow', () => {
      const rescanEnd = viewportOnly.indexOf('await rescanClawsDirFn();');
      expect(rescanEnd).toBeGreaterThan(-1);
      const afterRescan = viewportOnly.slice(rescanEnd, rescanEnd + 400);
      expect(afterRescan).toContain('clawPanel.materializeNow(clawTrackMap);');
    });

    it('materializeNow 调用位于 tui.start() 之前', () => {
      const materializeIdx = viewportOnly.indexOf('clawPanel.materializeNow(clawTrackMap);');
      const startIdx = viewportOnly.indexOf('tui.start();');
      expect(materializeIdx).toBeGreaterThan(-1);
      expect(startIdx).toBeGreaterThan(-1);
      expect(materializeIdx).toBeLessThan(startIdx);
    });

    it('保留 2 秒 clawScanInterval 与 cleanup', () => {
      expect(viewportOnly).toContain('clawScanInterval = setInterval(');
      expect(viewportOnly).toContain(', 2000);');
      const cleanupStart = viewportOnly.indexOf('await exitPromise;');
      const cleanupBlock = viewportOnly.slice(cleanupStart);
      expect(cleanupBlock).toContain('if (clawScanInterval) clearInterval(clawScanInterval);');
    });
  });

  // ==========================================================================
  // Phase 1150 Step C: changed-only clawBar render
  // ==========================================================================
  describe('Phase 1150 Step C: changed-only clawBar render', () => {
    const viewportOnly = fs.readFileSync(viewportPath, 'utf-8');
    const panelOnly = fs.readFileSync(clawPanelPath, 'utf-8');

    it('createClawPanel 注入 requestRender 回调', () => {
      expect(viewportOnly).toContain('createClawPanel({ attachedClawBar, requestRender: () => tui.requestRender() })');
    });

    it('scheduleClawPanelUpdate 无条件调用 updateClawPanel 且不直接 requestRender', () => {
      const scheduleMatch = viewportOnly.match(/const scheduleClawPanelUpdate = \(\): void => \{[\s\S]{0,200}?\};/);
      expect(scheduleMatch).toBeTruthy();
      const body = scheduleMatch![0];
      expect(body).toContain('clawPanel.updateClawPanel(clawTrackMap)');
      expect(body).not.toContain('tui.requestRender()');
      expect(body).not.toContain('clawTrackMap.size > 0');
    });

    it('clawPanel 内部比较最终文本并在变化时 requestRender', () => {
      expect(panelOnly).toContain('text === lastMaterializedText');
      expect(panelOnly).toContain('deps.requestRender?.()');
    });

    it('2 秒 interval、refreshAll、rescan 保持完整', () => {
      expect(viewportOnly).toContain('clawManager.refreshAllClawStatus();');
      expect(viewportOnly).toContain('void rescanClawsDirFn?.();');
      expect(viewportOnly).toContain('scheduleClawPanelUpdate();');
      expect(viewportOnly).toContain(', 2000);');
    });

    it('30 秒 status timer 与 stream 路径未改', () => {
      expect(viewportOnly).toContain('STATUS_BAR_REFRESH_MS = 30_000');
      expect(viewportOnly).toContain('statusBarRefreshInterval = setInterval(');
      expect(viewportOnly).toContain('streamReader.start(recentTurnOffset)');
    });
  });

  describe('Phase 1148 Step B: focus-events disabled', () => {
    const viewportOnly = fs.readFileSync(viewportPath, 'utf-8');

    it('不应写 DECSET 1004 enable/disable 序列', () => {
      expect(viewportOnly).not.toContain("\\x1b[?1004h");
      expect(viewportOnly).not.toContain("\\x1b[?1004l");
    });

    it('不应消费 ESC[I / ESC[O 的 focus listener', () => {
      expect(viewportOnly).not.toContain("\\x1b[I");
      expect(viewportOnly).not.toContain("\\x1b[O");
    });

    it('不应再注册 focusListener', () => {
      expect(viewportOnly).not.toContain('focusListener');
    });

    it('启动装配路径仍保留初始 setFocus(editor)', () => {
      const assemblyEnd = viewportOnly.indexOf('tui.start();');
      expect(assemblyEnd).toBeGreaterThan(-1);
      const assemblyBlock = viewportOnly.slice(0, assemblyEnd);
      expect(assemblyBlock).toContain('tui.setFocus(editor)');
    });

    it('cleanup 块不再写 DECSET 1004 disable', () => {
      const cleanupStart = viewportOnly.indexOf('await exitPromise;');
      expect(cleanupStart).toBeGreaterThan(-1);
      const cleanupBlock = viewportOnly.slice(cleanupStart);
      expect(cleanupBlock).not.toContain("\\x1b[?1004l");
    });
  });

  describe('Phase 1155 Step C: scrollback-preserving terminal adapter wiring', () => {
    const viewportOnly = fs.readFileSync(viewportPath, 'utf-8');

    it('应导入 createScrollbackPreservingTerminal', () => {
      expect(viewportOnly).toContain(
        "import { createScrollbackPreservingTerminal } from './chat-viewport-terminal.js';",
      );
    });

    it('应先构造 observability 再构造 adapter，避免 onSuppress 闭包 TDZ', () => {
      const obsIdx = viewportOnly.indexOf('createViewportObservability({ audit: options.audit })');
      const rawIdx = viewportOnly.indexOf('new ProcessTerminal()');
      expect(obsIdx).toBeGreaterThan(-1);
      expect(rawIdx).toBeGreaterThan(-1);
      expect(obsIdx).toBeLessThan(rawIdx);
    });

    it('TUI 应接收 adapter 包装后的 terminal，而非裸 ProcessTerminal', () => {
      expect(viewportOnly).toMatch(
        /const\s+terminal\s*=\s*createScrollbackPreservingTerminal\(\{[\s\S]*?\}\);\s*const\s+tui\s*=\s*new\s+TUI\(terminal\);/,
      );
    });

    it('不应出现 new TUI(new ProcessTerminal()) 或 new TUI(rawTerminal)', () => {
      expect(viewportOnly).not.toContain('new TUI(new ProcessTerminal()');
      expect(viewportOnly).not.toContain('new TUI(rawTerminal');
    });

    it('onSuppress 应委托到 observability.recordScrollbackClearSuppressed', () => {
      expect(viewportOnly).toContain(
        'onSuppress: (count) => observability.recordScrollbackClearSuppressed(count)',
      );
    });

    it('cleanup 仍通过 wrapper 调用 drainInput', () => {
      const cleanupStart = viewportOnly.indexOf('await exitPromise;');
      expect(cleanupStart).toBeGreaterThan(-1);
      const cleanupBlock = viewportOnly.slice(cleanupStart);
      expect(cleanupBlock).toContain('await terminal.drainInput()');
    });
  });
});

/**
 * Phase 1268 Step D: provider attempt / turn retry / cooldown 分层渲染（行为测试）
 * 反向验收：
 * - 同一 error 在 provider attempt 1/3、2/3、turn retry 1/3、cooldown 四种 fixture 输出必须可区分
 * - label（viewport 来源）与 deadline 缺一即失败
 * - 时间戳只断言结构（[HH:MM:SS]），不依赖运行机时区
 */
describe('Phase 1268 Step D: llm retry/cooldown viewport rendering', () => {
  function makeHandlerDeps(label = 'claw-x') {
    const lines: string[] = [];
    const auditWrites: unknown[][] = [];
    const deps = {
      turnTracker: { begin: () => {}, end: () => {}, abort: () => {}, interrupted: () => {}, getInterruptSource: () => null },
      mainUI: {
        flushThinking: () => {}, flushStreaming: () => {}, flushStreamingNormal: () => {},
        enterPhase: () => {}, clearPreview: () => {}, setPreview: () => {},
        appendToThinking: (s: string) => s, appendToBuffer: (s: string) => s,
        withScope: (_s: string, fn: () => void) => fn(),
      },
      sink: { emit: (d: { kind: string; text: string }) => { lines.push(d.text); } },
      showSystemMessages: false,
      showContractEvents: false,
      label,
      agentDir: '/tmp/agent',
      fsFactory: () => { throw new Error('not used'); },
      taskWatchMap: new Map(),
      handleTaskEvent: () => {},
      taskStatusBar: { addTrack: () => {}, addMigratedExec: () => {}, removeMigratedExec: () => {} },
      audit: { write: (...args: unknown[]) => { auditWrites.push(args); } },
      observability: { recordEvent: () => {} },
      getThinkingMode: () => 'off',
      resolvePending: () => {},
    };
    return { deps, lines, auditWrites };
  }

  const FIXED_TS = Date.parse('2026-08-02T13:06:27.000Z');
  const RESUME_AT = '2026-08-02T13:15:12.000Z';
  const CLOCK_RE = /\[\d{2}:\d{2}:\d{2}\]/;

  it('provider_attempt_failed 静默：不渲染行，audit 保留（phase 1276）', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps, lines, auditWrites } = makeHandlerDeps();
    const recordEvent = vi.fn();
    (deps.observability as any).recordEvent = recordEvent;
    const handle = createEventHandler(deps as any);

    handle({
      type: 'provider_attempt_failed', ts: FIXED_TS, provider: 'glm',
      attempt: 0, maxAttempts: 3, error: 'same boom', errorClass: 'rate_limit',
      userActionHint: 'wait_retry_after', retryAfterSec: 30,
    });

    // Phase 1276: provider 内部重试推进不呈现给用户（用户可见信息由
    // provider_failed 承担）；audit 记录保留。
    expect(lines).toHaveLength(0);
    expect(recordEvent).toHaveBeenCalledWith('provider_attempt_failed');
  });

  it('breaker_opened 静默：不渲染行，audit 保留（phase 1276）', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps, lines } = makeHandlerDeps();
    const handle = createEventHandler(deps as any);

    handle({ type: 'breaker_opened', provider: 'volc-glm', consecutiveFailures: 12 });

    expect(lines).toHaveLength(0);
  });

  it('turn retry 1/3 与 cooldown 行可区分，含 label 与 deadline', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps, lines } = makeHandlerDeps();
    const handle = createEventHandler(deps as any);

    handle({
      type: 'llm_retry_waiting', ts: FIXED_TS, stage: 'retry', action: 'scheduled',
      attempt: 1, maxAttempts: 3, delayMs: 60_000, resumeAt: RESUME_AT, errorClass: 'rate_limit',
    });
    handle({
      type: 'llm_retry_waiting', ts: FIXED_TS, stage: 'cooldown', action: 'scheduled',
      attempt: 3, maxAttempts: 3, delayMs: 300_000, resumeAt: RESUME_AT, errorClass: 'rate_limit',
    });
    handle({
      type: 'llm_retry_waiting', ts: FIXED_TS, stage: 'retry', action: 'released',
      attempt: 1, maxAttempts: 3, delayMs: 0, resumeAt: RESUME_AT, errorClass: 'rate_limit',
    });
    // phase 1276: gated 与 scheduled 同一等待，去重（不渲染）。
    handle({
      type: 'llm_retry_waiting', ts: FIXED_TS, stage: 'retry', action: 'gated',
      attempt: 1, maxAttempts: 3, delayMs: 29_975, resumeAt: RESUME_AT, errorClass: 'rate_limit',
    });

    expect(lines).toHaveLength(3);  // gated 不渲染，仍 3 行
    // Phase 1274: 行首 ⟳、无 [时间][label] 前缀。
    // Phase 1276: scheduled retry 行带 resume 绝对时钟锚点；gated 去重。
    expect(lines[0]).toContain('⟳');
    expect(lines[0]).toContain('turn retry 1/3 in 60s，resume at');
    expect(lines[0]).toMatch(/\d{2}:\d{2}:\d{2}/);  // resume 时钟（行内、无括号）
    expect(lines[1]).toContain('⟳');
    expect(lines[1]).toContain('rate-limit cooldown; probe at');
    expect(lines[1]).toMatch(/\d{2}:\d{2}:\d{2}/);  // probe 时钟（行内、无括号）
    expect(lines[2]).toContain('⟳');
    expect(lines[2]).toContain('llm retry wait released');
    for (const line of lines) {
      expect(line).not.toContain('[claw-x]');
    }
    expect(new Set(lines).size).toBe(3);  // 三种 fixture 输出互不相同
  });

  it('llm_retry_waiting 不触发 UNKNOWN_EVENT audit；非消费 event 仍走可观察 fallback', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps, auditWrites } = makeHandlerDeps();
    const handle = createEventHandler(deps as any);

    handle({
      type: 'llm_retry_waiting', ts: FIXED_TS, stage: 'retry', action: 'gated',
      attempt: 2, maxAttempts: 3, delayMs: 30_000, resumeAt: RESUME_AT, errorClass: 'transient',
    });
    handle({ type: 'provider_failover', ts: FIXED_TS, from: 'a', to: 'b', reason: 'test' });

    expect(auditWrites.filter(w => String(w[0]).includes('unknown') || String(w[1]).includes('provider_failover'))).toHaveLength(1);
  });

  it('recovery_scheduled：安排类型 + 错误分类穷尽渲染（phase 1826）', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps, lines } = makeHandlerDeps();
    const handle = createEventHandler(deps as any);

    handle({
      type: 'recovery_scheduled', scope: 'foreground', revision: 3, scheduleKind: 'at',
      resumeAt: RESUME_AT, errorClass: 'quota', providerCount: 1, failureCount: 1,
    });
    handle({
      type: 'recovery_scheduled', scope: 'foreground', revision: 4, scheduleKind: 'at',
      resumeAt: RESUME_AT, errorClass: 'rate_limit', providerCount: 1, failureCount: 2,
    });
    handle({
      type: 'recovery_scheduled', scope: 'foreground', revision: 5, scheduleKind: 'at',
      resumeAt: RESUME_AT, errorClass: 'transient', providerCount: 1, failureCount: 3,
    });
    handle({
      type: 'recovery_scheduled', scope: 'foreground', revision: 6, scheduleKind: 'on_change',
      resumeAt: '', errorClass: 'permanent', providerCount: 1, failureCount: 4,
    });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('quota recovery; next attempt at');
    expect(lines[1]).toContain('rate-limit recovery; next attempt at');
    expect(lines[2]).toContain('transient recovery; next attempt at');
    // 不能「不是 rate_limit 就 transient」：permanent 显示为需配置变化。
    expect(lines[3]).toContain('config change needed; waiting for intervention');
    expect(lines[3]).not.toContain('transient');
    for (const line of lines) expect(line).toContain('⟳');
  });

  it('recovery 结算类事件静默、状态写失败可见（phase 1826）', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps, lines, auditWrites } = makeHandlerDeps();
    const handle = createEventHandler(deps as any);

    handle({ type: 'recovery_ready', scope: 'foreground', revision: 7, reason: 'success' });
    handle({
      type: 'recovery_attempt_admitted', scope: 'foreground', revision: 7,
      attemptId: 'att-1', trigger: 'intervention', interventionCount: 1,
    });
    handle({
      type: 'recovery_attempt_finished', scope: 'foreground', revision: 7,
      attemptId: 'att-1', outcome: 'failed', accepted: true,
    });
    expect(lines).toHaveLength(0);

    handle({ type: 'recovery_state_write_failed', scope: 'foreground', reason: 'disk full', context: 'noteFailure' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('recovery state write failed');
    // 已知事件不落 UNKNOWN audit
    expect(auditWrites.filter(w => String(w[0]).includes('unknown'))).toHaveLength(0);
  });

  it('ALL_FAILED 连续失败序列只报第一次，成功 turn 后恢复（phase 1277）', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps, lines } = makeHandlerDeps();
    const handle = createEventHandler(deps as any);

    const allFailed = { type: 'turn_error', error: '[LLM_ALL_PROVIDERS_FAILED] All LLM providers failed: volc-glm (boom)' };
    handle(allFailed);
    handle(allFailed);  // 连续第二轮：不渲染
    handle(allFailed);  // 连续第三轮：不渲染
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('All LLM providers failed');

    handle({ type: 'turn_end' });  // 成功轮重置
    handle(allFailed);             // 重置后可再报
    expect(lines).toHaveLength(2);

    // 非 ALL_FAILED 的 turn_error 不受去重影响
    handle({ type: 'turn_error', error: 'some other error' });
    expect(lines).toHaveLength(3);
  });

  it('send_content_delta fragments accumulate and flush exactly once at send_content_end (phase 1273)', async () => {
    const { createEventHandler } = await import('../../src/viewport/chat-viewport-event-handler.js');
    const { deps } = makeHandlerDeps();
    const flushStreaming = vi.fn();
    const flushStreamingNormal = vi.fn();
    (deps.mainUI as any).flushStreaming = flushStreaming;
    (deps.mainUI as any).flushStreamingNormal = flushStreamingNormal;
    const handle = createEventHandler(deps as any);

    handle({ type: 'send_content_delta', delta: '收到' });
    handle({ type: 'send_content_delta', delta: '，' });
    handle({ type: 'send_content_delta', delta: '已重启' });
    handle({ type: 'send_content_end' });

    // Regression (phase 1273): a per-delta flushStreaming committed each
    // streamed fragment (LLM token granularity) as its own finished line.
    // Now the stream accumulates in the buffer and flushes once on end.
    expect(flushStreaming).not.toHaveBeenCalled();
    expect(flushStreamingNormal).toHaveBeenCalledTimes(1);
  });
});
