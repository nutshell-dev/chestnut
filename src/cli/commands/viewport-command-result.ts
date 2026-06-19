/**
 * @module L6.CLI.ChatViewport.CommandResult
 * Slash 命令的返回类型：commands 不直接 mutate TUI state、改为构造 descriptors
 * 数组让 TUI 适配层（chat-viewport.ts editor.onSubmit）dispatch 到 sink。
 *
 * launcher 等外部 viewport 复用 commands 时实现自己的 sink 消费 descriptors。
 */

import type { RenderDescriptor } from './viewport-render-descriptor.js';

export interface CommandResult {
  descriptors: RenderDescriptor[];
}

export const emptyResult = (): CommandResult => ({ descriptors: [] });

export const textResult = (color: string, text: string): CommandResult => ({
  descriptors: [{ kind: 'text-line', color, text }],
});
