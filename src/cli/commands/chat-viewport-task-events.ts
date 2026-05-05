/**
 * @module L6.CLI.ChatViewport.TaskEvents
 * Task event handler factory — 异步 dispatch/spawn subagent progress 事件渲染
 *
 * Migrated from chat-viewport.ts:238-277 (phase 484 Step B)
 * 0 闭包依赖 / 接受 TaskEventHandlerDeps 参
 */

export interface TaskEventHandlerDeps {
  getTaskWatch: (taskId: string) => { silent: boolean } | undefined;
  showRecapStream: () => boolean;
  appendOutput: (color: string, text: string, wrap?: boolean, hangIndent?: string) => void;
  stopTaskWatch: (taskId: string) => void;
}

export type TaskEvent = {
  type: string;
  name?: unknown;
  success?: unknown;
  step?: unknown;
  maxSteps?: unknown;
  summary?: unknown;
  [key: string]: unknown;
};

export function createTaskEventHandler(deps: TaskEventHandlerDeps) {
  return (taskId: string, callerType: string, event: TaskEvent) => {
    const tw = deps.getTaskWatch(taskId);
    const prefix = callerType;
    switch (event.type) {
      case 'tool_call':
        if (tw?.silent && !deps.showRecapStream()) break;
        deps.appendOutput('\x1b[36m', `⚙ ${prefix}:${event.name}`);
        break;
      case 'tool_result': {
        if (tw?.silent && !deps.showRecapStream()) break;
        const icon = event.success ? '✓' : '✗';
        deps.appendOutput('\x1b[2m', `  ${icon} [${event.step}/${event.maxSteps}] ${event.summary as string}`);
        break;
      }
      case 'turn_end':
      case 'turn_error':
 case 'turn_interrupted':
        deps.stopTaskWatch(taskId);
        break;
    }
  };
}
