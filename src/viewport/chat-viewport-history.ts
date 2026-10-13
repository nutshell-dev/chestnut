/**
 * Viewport history store + fixed-height window model.
 *
 * 职责（phase 1937 Step B）：
 * - 保存应用侧历史行（逻辑行数组，沿用 OUTPUT_LINES_CAP 上限）；
 * - 按需物化：只把窗口所需的物理行（折行后）交给 TUI，窗口高度由调用方
 *   按终端高度减去保留区计算，Terminal 不再接收完整历史；
 * - 窗口游标：followTail（底部跟随）/ 逻辑行锚点（浏览时保持用户正在看的
 *   内容不随新事件漂移）/ 未读计数。
 *
 * 历史事实来源仍是持久化 stream；本模块只管理展示窗口。stream 按需回读
 * 接口留待后续（owner 待核证），当前窗口全部来自本会话物化的行。
 *
 * 失败语义：物化遇到结构损坏的行（text/color 非字符串）时不静默丢弃，
 * 返回 typed failure，窗口状态（游标）保留，供上层呈现可观察错误并重试。
 */

import { fitLine, wrapLine } from './terminal-text.js';

export interface OutputLine {
  color: string;
  text: string;
  wrap?: boolean;
  hangIndent?: string;
}

/** 应用侧历史行上限（原 display 的 OUTPUT_LINES_CAP；phase 1937 移入 history owner）。 */
export const OUTPUT_LINES_CAP = 5000;

/** 窗口最少可见行——极小终端下窗口不塌缩为 0。 */
export const MIN_HISTORY_WINDOW_LINES = 1;

export interface HistoryWindowOk {
  kind: 'ok';
  /** 窗口物理行（已折行、含颜色码），长度 ≤ requested height。 */
  lines: string[];
  /** 窗口首行在全部物理行中的下标。 */
  firstVisibleLine: number;
  /** 窗口实际包含的物理行数。 */
  visibleLineCount: number;
  /** 全部物化物理行数。 */
  totalLines: number;
  followTail: boolean;
  /** 浏览历史期间新追加的逻辑行数（回到底部清零）。 */
  unreadLines: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface HistoryWindowFailure {
  kind: 'failed';
  /** 不含历史内容（隐私边界），只描述位置与原因。 */
  reason: string;
}

export type HistoryWindow = HistoryWindowOk | HistoryWindowFailure;

export interface ViewportHistoryOptions {
  /** 应用侧逻辑行上限，默认 OUTPUT_LINES_CAP（可调仅供测试与超大历史验证）。 */
  cap?: number;
}

export interface ViewportHistory {
  readonly lines: readonly OutputLine[];
  append(line: OutputLine): void;
  clear(): void;
  /** 旧 display.resolvePending 语义：从头部起最多 count 条 ` (pending)` 结尾的行去后缀。 */
  resolvePending(count: number): void;
  logicalCount(): number;
  invalidateMaterialization(): void;

  renderWindow(cols: number, height: number): HistoryWindow;

  scrollUp(lines: number): void;
  scrollDown(lines: number): void;
  pageUp(): void;
  pageDown(): void;
  toOldest(): void;
  toBottom(): void;
  isFollowingTail(): boolean;
  unreadLines(): number;
}

interface Materialized {
  cols: number;
  physical: string[];
  /** 每逻辑行的物理行数（与 lines 下标对齐）。 */
  counts: number[];
  /** prefix[i] = 逻辑行 i 之前的物理行总数。 */
  prefix: number[];
}

export function createViewportHistory(opts: ViewportHistoryOptions = {}): ViewportHistory {
  const cap = Math.max(1, opts.cap ?? OUTPUT_LINES_CAP);
  const lines: OutputLine[] = [];

  let cache: Materialized | null = null;
  /** 最近一次物化使用的 cols——append 使 cache 失效后，滚动键仍需映射锚点。 */
  let lastCols = 0;
  let followTail = true;
  // 浏览锚点：窗口首行 = 逻辑行 anchor 的第 anchorWithin 个物理行。
  let anchor = 0;
  let anchorWithin = 0;
  let unreadSinceScroll = 0;
  let lastTotalLines = 0;
  let lastVisibleCount = MIN_HISTORY_WINDOW_LINES;

  const invalidate = () => { cache = null; };

  const materialize = (cols: number): Materialized | { failed: string } => {
    if (cache && cache.cols === cols) return cache;
    lastCols = cols;
    const physical: string[] = [];
    const counts: number[] = [];
    const prefix: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line: OutputLine | undefined = lines[i];
      if (!line || typeof line.text !== 'string' || typeof line.color !== 'string') {
        // 损坏行（未来 stream 回读/外部注入边界）：不猜测内容、不静默跳过
        return { failed: `corrupt history line at logical index ${i}` };
      }
      prefix.push(physical.length);
      const parts = line.wrap
        ? line.text.split('\n').flatMap(l => wrapLine(l, cols, line.hangIndent))
        : [fitLine(line.text, cols)];
      for (const p of parts) {
        physical.push(line.color ? `${line.color}${p}\x1b[0m` : p);
      }
      counts.push(parts.length);
    }
    cache = { cols, physical, counts, prefix };
    return cache;
  };

  /** 绝对物理行下标 → 锚点（二分 prefix）。abs 已被夹在 [0, total-1]。 */
  const setAnchorFromAbs = (abs: number, m: Materialized) => {
    if (m.counts.length === 0) {
      anchor = 0;
      anchorWithin = 0;
      return;
    }
    let lo = 0;
    let hi = m.prefix.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (m.prefix[mid] <= abs) lo = mid;
      else hi = mid - 1;
    }
    anchor = lo;
    anchorWithin = Math.min(abs - m.prefix[lo], m.counts[lo] - 1);
  };

  // 滚动发生在两次 render 之间时复用最近一次物化结果；锚点是逻辑行下标，
  // 与 cols 无关，即使 cache 是换宽前的布局也能映射到正确逻辑位置。
  // append 使 cache 失效后按最近 cols 重建，滚动键不因「尚未重渲染」空转。
  const currentMaterialized = (): Materialized | null => {
    if (cache) return cache;
    if (lastCols <= 0 || lines.length === 0) return null;
    const m = materialize(lastCols);
    return 'physical' in m ? m : null;
  };

  const maxStart = () => Math.max(0, lastTotalLines - lastVisibleCount);

  const currentStartAbs = (): number => {
    const m = currentMaterialized();
    if (followTail || !m || m.counts.length === 0) return maxStart();
    const clamped = Math.min(anchor, m.counts.length - 1);
    return Math.min(Math.max(0, m.prefix[clamped] + anchorWithin), maxStart());
  };

  const renderWindow = (cols: number, height: number): HistoryWindow => {
    const requested = Math.max(MIN_HISTORY_WINDOW_LINES, Math.floor(height));
    const m = materialize(cols);
    if (!('physical' in m)) {
      return { kind: 'failed', reason: m.failed };
    }
    const total = m.physical.length;
    lastVisibleCount = requested;

    let startAbs: number;
    if (followTail || total <= requested) {
      followTail = true;
      startAbs = Math.max(0, total - requested);
    } else {
      const clamped = Math.min(anchor, m.counts.length - 1);
      startAbs = Math.min(Math.max(0, m.prefix[clamped] + anchorWithin), Math.max(0, total - requested));
      if (startAbs >= total - requested) {
        // 内容缩水（cap 裁剪）后窗口被推到底部：恢复 follow-tail
        followTail = true;
        unreadSinceScroll = 0;
        startAbs = Math.max(0, total - requested);
      }
    }

    lastTotalLines = total;
    const windowLines = m.physical.slice(startAbs, startAbs + requested);
    const end = startAbs + windowLines.length;
    return {
      kind: 'ok',
      lines: windowLines,
      firstVisibleLine: startAbs,
      visibleLineCount: windowLines.length,
      totalLines: total,
      followTail,
      unreadLines: unreadSinceScroll,
      hasOlder: startAbs > 0,
      hasNewer: end < total,
    };
  };

  const scrollUp = (count: number) => {
    if (count <= 0) return;
    const m = currentMaterialized();
    if (!m || m.physical.length === 0) return;
    const before = currentStartAbs();
    const next = Math.max(0, before - count);
    if (next === before && followTail) return;
    setAnchorFromAbs(next, m);
    followTail = next >= maxStart();
  };

  const scrollDown = (count: number) => {
    if (count <= 0) return;
    const m = currentMaterialized();
    if (!m || m.physical.length === 0) return;
    const before = currentStartAbs();
    const next = Math.min(maxStart(), before + count);
    if (next >= maxStart()) {
      followTail = true;
      unreadSinceScroll = 0;
      return;
    }
    setAnchorFromAbs(next, m);
    followTail = false;
  };

  const pageUp = () => scrollUp(Math.max(1, lastVisibleCount - 1));
  const pageDown = () => scrollDown(Math.max(1, lastVisibleCount - 1));

  const toOldest = () => {
    const m = currentMaterialized();
    if (!m || m.physical.length === 0 || maxStart() === 0) return;
    setAnchorFromAbs(0, m);
    followTail = false;
  };

  const toBottom = () => {
    followTail = true;
    unreadSinceScroll = 0;
  };

  const append = (line: OutputLine) => {
    lines.push(line);
    if (lines.length > cap) {
      const over = lines.length - cap;
      lines.splice(0, over);
      // 锚点随裁剪前移，保持用户正在看的逻辑行不漂移
      anchor = Math.max(0, anchor - over);
    }
    invalidate();
    if (!followTail) unreadSinceScroll += 1;
  };

  const clear = () => {
    lines.length = 0;
    invalidate();
    followTail = true;
    unreadSinceScroll = 0;
    anchor = 0;
    anchorWithin = 0;
    lastTotalLines = 0;
  };

  const resolvePending = (count: number) => {
    if (count <= 0) return;
    let remaining = count;
    for (const line of lines) {
      if (line.text.endsWith(' (pending)')) {
        line.text = line.text.slice(0, -' (pending)'.length);
        remaining--;
        if (remaining === 0) break;
      }
    }
    invalidate();
  };

  return {
    lines,
    append,
    clear,
    resolvePending,
    logicalCount: () => lines.length,
    invalidateMaterialization: invalidate,
    renderWindow,
    scrollUp,
    scrollDown,
    pageUp,
    pageDown,
    toOldest,
    toBottom,
    isFollowingTail: () => followTail,
    unreadLines: () => unreadSinceScroll,
  };
}
