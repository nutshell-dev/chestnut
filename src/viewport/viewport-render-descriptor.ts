/**
 * @module L6.CLI.ChatViewport.RenderDescriptor
 * 事件 handler 与 TUI 适配的解耦点：descriptor 是渲染语义（structured），
 * sink 是 TUI 适配（具体调 appendOutput / setText 等 pi-tui 副作用）。
 *
 * launcher 等外部 viewport 实现各自的 DescriptorSink（→ Tauri React state、
 * Raycast List items 等）即可复用事件语义层、不动 event-handler。
 *
 * Step A 引入 text-line 一类。Step B 扩 clear-lines / invalidate-cache /
 * claw-panel-update 三类（命令语义层用）。
 */

export type RenderDescriptor =
  | { kind: 'text-line'; color: string; text: string; wrap?: boolean; hangIndent?: string }
  | { kind: 'clear-lines' }
  | { kind: 'invalidate-cache' }
  | { kind: 'claw-panel-update' };

export interface DescriptorSink {
  emit(d: RenderDescriptor): void;
}
