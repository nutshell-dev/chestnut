/**
 * @module L6.CLI.ChatViewport.TaskEvents
 * Task event handler factory — 异步 dispatch/spawn subagent progress 事件渲染
 *
 * Migrated from chat-viewport.ts:238-277 (phase 484 Step B)
 * 0 闭包依赖 / 接受 TaskEventHandlerDeps 参
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import type { TaskStatusBarController } from './chat-viewport-task-status-bar.js';
import type { TaskId } from '../../core/async-task-system/types.js';


export interface TaskEventHandlerDeps {
  stopTaskWatch: (taskId: TaskId) => void;
  taskStatusBar: TaskStatusBarController;
  audit?: AuditLog;
}

export type TaskEvent = {
  type: string;
  name?: unknown;
  success?: unknown;
  step?: unknown;
  maxSteps?: unknown;
  summary?: unknown;
  delta?: unknown;
  [key: string]: unknown;
};

export function createTaskEventHandler(deps: TaskEventHandlerDeps) {
  return (taskId: TaskId, event: TaskEvent) => {
    switch (event.type) {
      case 'tool_call':
      case 'tool_result':
      case 'thinking_delta':
      case 'text_delta':
        deps.taskStatusBar.updateTrack(taskId, event);
        break;
      case 'turn_end':
      case 'turn_error':
      case 'turn_interrupted':
        deps.taskStatusBar.updateTrack(taskId, event);   // 内部 removeTrack
        deps.stopTaskWatch(taskId);
        break;
      default:
        deps.audit?.write(
          VIEWPORT_AUDIT_EVENTS.UNKNOWN_EVENT,
          `context=task_event`,
          `type=${String(event.type)}`,
          `taskId=${taskId}`,
        );
        break;
    }
  };
}
