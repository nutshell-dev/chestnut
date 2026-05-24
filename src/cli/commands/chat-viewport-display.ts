/**
 * Terminal display rendering + output buffer management + resize handler
 * What: body cache, output lines cap, wrap/fit, and resize coordination
 * When: output changes, terminal resizes, or display refresh needed
 * Why: terminal rendering strategy (wrap/fit/cache) evolves independently of event handling
 */

import { wrapLine, fitLine } from '../utils/string.js';
import { OUTPUT_LINES_CAP } from './constants.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { createViewportObservability } from './chat-viewport-observability.js';

export interface OutputLine {
  color: string;
  text: string;
  wrap?: boolean;
  hangIndent?: string;
}

export interface DisplayDeps {
  label: string;
  outputText: { setText(text: string): void };
  tui: { requestRender(): void };
  observability: ReturnType<typeof createViewportObservability>;
  mainUI?: MainTurnUIController;
  // for onResize
  updateClawPanel: () => void;
  spawnText: { setText(text: string): void };
  shadowText: { setText(text: string): void };
  taskStatusBar: { renderSpawn(cols: number): string; renderShadow(cols: number): string };
}

export function createDisplay(deps: DisplayDeps) {
  const outputLines: OutputLine[] = [
    { color: '', text: `[${deps.label}] Watching daemon activity...` },
  ];
  let bodyCache: string | null = null;
  let bodyCacheCols = -1;

  const invalidateBodyCache = () => { bodyCache = null; };

  const updateDisplay = () => {
    const startNow = performance.now();
    const cols = process.stdout.columns ?? 80;

    // body 重算：cache miss 或 cols 变才重算
    if (bodyCache === null || bodyCacheCols !== cols) {
      bodyCache = outputLines
        .flatMap(({ color, text, wrap, hangIndent }) => {
          const lines = wrap
            ? text.split('\n').flatMap(line => wrapLine(line, cols, hangIndent))
            : [fitLine(text, cols)];
          return lines.map(line => color ? `${color}${line}\x1b[0m` : line);
        })
        .join('\n');
      bodyCacheCols = cols;
    }

    const currentStatus = deps.mainUI ? deps.mainUI.getStatus() : '';
    const currentPreview = deps.mainUI ? deps.mainUI.getPreview() : '';
    const composed = [currentStatus, currentPreview].filter(Boolean).join('\n');
    const suffixBody = composed
      ? composed.split('\n').flatMap(line => wrapLine(line, cols)).join('\n')
      : '';

    const full = suffixBody ? bodyCache + '\n' + suffixBody : bodyCache;
    deps.outputText.setText(full ?? '');
    deps.tui.requestRender();
    const suffixLines = suffixBody ? suffixBody.split('\n').length : 0;
    deps.observability.recordRender({
      outputLines: outputLines.length,
      suffixLines,
      elapsedMs: performance.now() - startNow,
    });
  };

  const appendOutput = (color: string, text: string, wrap = false, hangIndent = '') => {
    outputLines.push({ color, text, wrap, hangIndent });
    if (outputLines.length > OUTPUT_LINES_CAP) {
      outputLines.splice(0, outputLines.length - OUTPUT_LINES_CAP);
    }
    invalidateBodyCache();   // outputLines 变 / cache 失效 / 下次 updateDisplay 重算
    updateDisplay();
  };

  const clearOutputLines = () => { outputLines.length = 0; };

  const onResize = () => {
    deps.updateClawPanel();
    const cols = process.stdout.columns ?? 80;
    deps.spawnText.setText(deps.taskStatusBar.renderSpawn(cols));
    deps.shadowText.setText(deps.taskStatusBar.renderShadow(cols));
    updateDisplay();
  };

  return {
    outputLines,
    invalidateBodyCache,
    updateDisplay,
    appendOutput,
    clearOutputLines,
    onResize,
  };
}
