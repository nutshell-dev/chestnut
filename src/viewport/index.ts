/**
 * @module L6.Viewport
 * Chat Viewport 独立模块入口。
 *
 * phase 1874 Step B（cli-viewport-module-boundary）：自 CLIProcess 内部子面提取为独立模块。
 * 本模块 own：draft 持久化（`viewport-draft.json`）、terminal adapter、stream/task watchers、
 * task tracks、viewport audit namespace（四高频事件落 viewport.tsv）与退出清理。
 * CLIProcess 只经本入口消费（跨模块 deep import 由 lint:arch no-deep-into-module-viewport 守）；
 * 内部文件（19 个子件）不构成对外面。
 */

export { runChatViewport, type ChatViewportOptions } from './chat-viewport.js';
export {
  createViewportAudit,
  VIEWPORT_AUDIT_EVENTS,
  VIEWPORT_FILE_ROUTING,
} from './viewport-audit-events.js';
export { VIEWPORT_DRAFT_FILE } from './chat-viewport-draft.js';
export type { CliStreamEvent } from './stream-event-types.js';
// phase 1874 Step B: CLI 与 viewport 共用的终端文本呈现原语（CLIProtocol 有 zod-only bare 白名单、不容 string-width）
export {
  DEFAULT_TERMINAL_WIDTH,
  fitLine,
  prefixLines,
  sliceFromStart,
  wrapLine,
} from './terminal-text.js';
