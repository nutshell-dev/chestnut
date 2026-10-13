/**
 * Terminal display rendering + output buffer management + resize handler
 * What: fixed-height history window render, footer (status/preview) budget, resize coordination
 * When: output changes, terminal resizes, scroll input, or display refresh needed
 * Why: terminal rendering strategy (window/fit/cache) evolves independently of event handling
 *
 * phase 1937 Step B: 输出不再把全部历史交给 pi-tui/Terminal。历史行存于
 * `chat-viewport-history`，本模块每次只把「固定高度窗口 + 有界 footer」写入
 * outputText；窗口高度 = 终端行数 − 下方组件保留行 − footer 行数。
 */

import { wrapLine, fitLine } from './terminal-text.js';
import { DEFAULT_TERMINAL_WIDTH, DEFAULT_TERMINAL_HEIGHT } from './terminal-text.js';
import { createViewportHistory, MIN_HISTORY_WINDOW_LINES } from './chat-viewport-history.js';
import type { OutputLine, ViewportHistory } from './chat-viewport-history.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { ViewportHistoryControls } from './chat-viewport-types.js';
import type { createViewportObservability } from './chat-viewport-observability.js';
import type { ClawTrack } from './chat-viewport-claw-line.js';
import type { DescriptorSink, RenderDescriptor } from './viewport-render-descriptor.js';

const PREVIEW_HANG_INDENT = '  ';
/** streaming preview 最多占用「可用高度」的比例（phase 1937：preview 必须有界，否则流式文本会把 Terminal scrollback 拉长）。 */
const PREVIEW_MAX_FRACTION = 1 / 3;
const MIN_PREVIEW_LINES = 2;

export type { OutputLine };

interface DisplayDeps {
  label: string;
  outputText: { setText(text: string): void };
  tui: { requestRender(): void };
  observability: ReturnType<typeof createViewportObservability>;
  mainUI?: MainTurnUIController;
  // for onResize
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
  clawTrackMap: Map<string, ClawTrack>;
  spawnText: { setText(text: string): void };
  shadowText: { setText(text: string): void };
  migratedExecText: { setText(text: string): void };
  taskStatusBar: { renderSpawn(cols: number): string; renderShadow(cols: number): string; renderMigratedExec(cols: number): string };
  // phase 1937: 终端几何 / 保留区（默认读 process.stdout；测试可注入）
  history?: ViewportHistory;
  getCols?: () => number;
  getRows?: () => number;
  /** outputText 下方（状态条/编辑器等）与 footer 之外占用的行数，每次 render 动态求值。 */
  getReservedRows?: () => number;
}

export function createDisplay(deps: DisplayDeps) {
  const history = deps.history ?? createViewportHistory();
  if (history.logicalCount() === 0) {
    history.append({ color: '', text: `[${deps.label}] Watching daemon activity...` });
  }
  const getCols = deps.getCols ?? (() => process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH);
  const getRows = deps.getRows ?? (() => process.stdout.rows ?? DEFAULT_TERMINAL_HEIGHT);
  const getReservedRows = deps.getReservedRows ?? (() => 0);
  let lastWindowFailure: string | null = null;

  const refreshStatusTexts = (cols: number) => {
    deps.spawnText.setText(deps.taskStatusBar.renderSpawn(cols));
    deps.shadowText.setText(deps.taskStatusBar.renderShadow(cols));
    deps.migratedExecText.setText(deps.taskStatusBar.renderMigratedExec(cols));
  };

  const historyHint = (cols: number, unread: number): string => {
    const unreadPart = unread > 0 ? `新消息 ${unread} 行 · ` : '';
    const text = fitLine(`── ↑ 浏览历史中（${unreadPart}PgDn / End 回到底部）──`, cols);
    return `\x1b[2m${text}\x1b[0m`;
  };

  const updateDisplay = () => {
    const startNow = performance.now();
    const cols = getCols();

    // task status bar texts 每次 display 刷新时重算，确保 migratedExec 等的时间标签实时更新
    refreshStatusTexts(cols);

    const currentStatus = deps.mainUI ? deps.mainUI.getStatus() : '';
    const currentPreview = deps.mainUI ? deps.mainUI.getPreview() : '';
    // phase 1200: preview 需要 hangIndent（自动换行时保持缩进），status 不需要
    const statusLines = currentStatus ? currentStatus.split('\n').flatMap(line => wrapLine(line, cols)) : [];
    const previewWrapped = currentPreview ? currentPreview.split('\n').flatMap(line => wrapLine(line, cols, PREVIEW_HANG_INDENT)) : [];

    const rows = getRows();
    const reservedBelow = getReservedRows();
    // preview 有界：最多占可用高度的 PREVIEW_MAX_FRACTION（尾部保留最新流式内容）
    const previewBudget = Math.max(MIN_PREVIEW_LINES, Math.floor((rows - reservedBelow) * PREVIEW_MAX_FRACTION));
    const previewLines = previewWrapped.length > previewBudget ? previewWrapped.slice(-previewBudget) : previewWrapped;
    const footerBase = [...statusLines, ...previewLines];

    // 浏览历史时需要 1 行提示位；以渲染前状态预留（状态翻转的极端帧至多多渲染 1 行、有界）
    const probeBrowsing = !history.isFollowingTail();
    const hintReserve = probeBrowsing ? 1 : 0;
    const windowHeight = Math.max(
      MIN_HISTORY_WINDOW_LINES,
      rows - reservedBelow - footerBase.length - hintReserve,
    );

    const window = history.renderWindow(cols, windowHeight);
    if (window.kind !== 'ok') {
      // 不静默丢弃：错误可见 + audit（去重）+ 游标保留（history 状态未被回滚）
      if (lastWindowFailure !== window.reason) {
        lastWindowFailure = window.reason;
        deps.observability.recordHistoryWindowFailed(window.reason);
      }
      deps.outputText.setText(`\x1b[31m[history window failed: ${window.reason}]\x1b[0m`);
      deps.tui.requestRender();
      deps.observability.recordRender({
        outputLines: history.logicalCount(),
        suffixLines: 0,
        windowLines: 0,
        elapsedMs: performance.now() - startNow,
      });
      return;
    }
    lastWindowFailure = null;

    const hintLines = window.followTail ? [] : [historyHint(cols, window.unreadLines)];
    const body = [...window.lines, ...hintLines, ...footerBase];
    deps.outputText.setText(body.join('\n'));
    deps.tui.requestRender();
    deps.observability.recordRender({
      outputLines: history.logicalCount(),
      suffixLines: footerBase.length,
      windowLines: window.lines.length,
      elapsedMs: performance.now() - startNow,
    });
  };

  const appendOutput = (color: string, text: string, wrap = false, hangIndent = '') => {
    history.append({ color, text, wrap, hangIndent });
    updateDisplay();
  };

  const clearOutputLines = () => { history.clear(); };

  const onResize = () => {
    deps.updateClawPanel(deps.clawTrackMap);
    refreshStatusTexts(getCols());
    updateDisplay();
  };

  const descriptorSink: DescriptorSink = {
    emit(d: RenderDescriptor): void {
      switch (d.kind) {
        case 'text-line':
          appendOutput(d.color, d.text, d.wrap, d.hangIndent);
          return;
        case 'clear-lines':
          clearOutputLines();
          return;
        case 'invalidate-cache':
          history.invalidateMaterialization();
          return;
        case 'claw-panel-update':
          deps.updateClawPanel(deps.clawTrackMap);
          return;
        default: {
          const _exhaustive: never = d;
          return _exhaustive;
        }
      }
    },
  };

  const resolvePending = (count: number) => {
    if (count <= 0) return;
    history.resolvePending(count);
    updateDisplay();
  };

  const historyControls: ViewportHistoryControls = {
    isBrowsing: () => !history.isFollowingTail(),
    scrollUp: (count: number) => { history.scrollUp(count); updateDisplay(); },
    scrollDown: (count: number) => { history.scrollDown(count); updateDisplay(); },
    pageUp: () => { history.pageUp(); updateDisplay(); },
    pageDown: () => { history.pageDown(); updateDisplay(); },
    toOldest: () => { history.toOldest(); updateDisplay(); },
    toBottom: () => { history.toBottom(); updateDisplay(); },
  };

  return {
    history,
    historyControls,
    updateDisplay,
    appendOutput,
    clearOutputLines,
    resolvePending,
    onResize,
    descriptorSink,
    refreshStatusTexts,
  };
}
