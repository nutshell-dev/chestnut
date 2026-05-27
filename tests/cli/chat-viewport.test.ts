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
import { createMainTurnUI } from '../../src/cli/commands/chat-viewport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewportPath = path.join(__dirname, '../../src/cli/commands/chat-viewport.ts');
const mainTurnUIPath = path.join(__dirname, '../../src/cli/commands/main-turn-ui.ts');
const clawLinePath = path.join(__dirname, '../../src/cli/commands/chat-viewport-claw-line.ts');
const taskEventsPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-task-events.ts');
const clawManagerPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-claw-manager.ts');
const commandsPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-commands.ts');
const turnTrackerPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-turn-tracker.ts');
const eventHandlerPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-event-handler.ts');
const clawPanelPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-claw-panel.ts');
const displayPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-display.ts');
const initPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-init.ts');

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
    it('text_delta handler 中应设置 bufferType = text', () => {
      // 找到 text_delta 处理逻辑
      const textDeltaMatch = sourceCode.match(
        /\} else if \(ev\.type === 'text_delta'\) \{[\s\S]{0,400}?\}/
      );
      expect(textDeltaMatch).toBeTruthy();
      
      const textDeltaBlock = textDeltaMatch![0];
      
      // 应该在 if (track.bufferType !== 'text') 块内设置 bufferType
      expect(textDeltaBlock).toContain("track.bufferType = 'text'");
    });

    it('bufferType 赋值应在 if 块内，而非每次 delta 都赋值', () => {
      const textDeltaSection = sourceCode.slice(
        sourceCode.indexOf("} else if (ev.type === 'text_delta')"),
        sourceCode.indexOf("} else if (ev.type === 'tool_result')")
      );
      
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
      const helpStart = sourceCode.indexOf("'可用命令：'");
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

    it('flushStreaming 传 indent 作为 hangIndent', () => {
      const flushMatch = sourceCode.match(
        /const flushStreaming[\s\S]{0,700}?appendOutput\([^)]+\)/
      );
      expect(flushMatch![0]).toMatch(/appendOutput\(.*indent\)/);
    });

    it('flushThinking 传 indent 作为 hangIndent', () => {
      const flushMatch = sourceCode.match(
        /const flushThinking[\s\S]{0,500}?appendOutput\([^)]+\)/
      );
      expect(flushMatch![0]).toMatch(/appendOutput\(.*indent\)/);
    });
  });

  // ==========================================================================
  // Phase 91 step5-7: 死循环修复 / 死代码清理 / indent 一致性
  // ==========================================================================
  describe('Phase 91 step5: wrapLine Math.max 防死循环', () => {
    it('wrapLine 实现中应有 Math.max(1', () => {
      const wrapLineSrc = fs.readFileSync(
        path.join(__dirname, '../../src/cli/utils/string.ts'), 'utf-8'
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

  describe('Phase 91 step7: thinking_delta indent 用 stringWidth 计算', () => {
    it('thinking_delta 中 indent 应使用 stringWidth(prefix)', () => {
      const eventHandlerCode = fs.readFileSync(eventHandlerPath, 'utf-8');
      const tdStart = eventHandlerCode.indexOf("case 'thinking_delta':");
      expect(tdStart).toBeGreaterThan(-1);
      const tdEnd = eventHandlerCode.indexOf('break;', tdStart);
      expect(tdEnd).toBeGreaterThan(-1);
      const tdSection = eventHandlerCode.slice(tdStart, tdEnd + 6);
      expect(tdSection).toContain('stringWidth(prefix)');
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
        audit: { write: () => {} },
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
});
