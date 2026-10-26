/**
 * @module L6.CLIProtocol.ClawBarDisplay
 *
 * claw bar 错误/终止状态行格式化单源（phase 2003 Step E）：
 * viewport（chat-viewport-claw-line，负责 ANSI/颜色/fitLine 外壳）与 launcher
 * （activity error detail / statusLine 原样展示）共用同一格式化结果——
 * 同一错误类别、符号、前缀、摘要与 duration 规则；后续格式变更只改本模块。
 *
 * 纯文本输出：不含 ANSI、不按终端宽度截断（截断归各自外壳：viewport fitLine /
 * launcher UI lineLimit）。本模块零依赖（cli-protocol 叶子约束），duration
 * 格式化与 viewport fmtDuration 同规则内联实现（m / h m）。
 */

/** claw bar 错误/终止显示状态（不含 active/starting/no-contract/idle-○ 等非错误分支）。 */
export type ClawBarErrorState =
  | { kind: 'daemon_unreadable' }
  | { kind: 'daemon_stopped' }
  | { kind: 'error'; message: string; inactiveMs?: number }
  | { kind: 'interrupted'; inactiveMs?: number }
  | { kind: 'retry'; message: string }
  | { kind: 'blocked'; message: string };

/** 单行净化：换行/连续空白折为单个空格（claw bar 单行约束）。 */
function sanitizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 与 viewport chat-viewport-utils fmtDuration 完全同规则（`3m` / `1h 5m`）。 */
function fmtInactiveDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function inactiveSuffix(inactiveMs: number | undefined): string {
  return inactiveMs !== undefined ? ` · inactive ${fmtInactiveDuration(inactiveMs)}` : '';
}

/**
 * 格式化 claw bar 错误/终止行（不含 ANSI/颜色/截断）。
 * 形状与 viewport buildClawLine 逐字节一致：
 * `[id] ✗ daemon unreadable|daemon stopped` / `[id] ✗ <msg> · inactive 3m` /
 * `[id] ✗ interrupted · inactive 3m` / `[id] ⟳ <msg>`（可恢复）/ `[id] ⏸ <msg>`（终局）。
 */
export function formatClawBarError(clawId: string, state: ClawBarErrorState): string {
  switch (state.kind) {
    case 'daemon_unreadable':
      return `[${clawId}] ✗ daemon unreadable`;
    case 'daemon_stopped':
      return `[${clawId}] ✗ daemon stopped`;
    case 'error':
      return `[${clawId}] ✗ ${sanitizeLine(state.message)}${inactiveSuffix(state.inactiveMs)}`;
    case 'interrupted':
      return `[${clawId}] ✗ interrupted${inactiveSuffix(state.inactiveMs)}`;
    case 'retry':
      return `[${clawId}] ⟳ ${sanitizeLine(state.message)}`;
    case 'blocked':
      return `[${clawId}] ⏸ ${sanitizeLine(state.message)}`;
  }
}
