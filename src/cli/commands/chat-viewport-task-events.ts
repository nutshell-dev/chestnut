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
import type { DescriptorSink } from './viewport-render-descriptor.js';


export interface TaskEventHandlerDeps {
  stopTaskWatch: (taskId: TaskId) => void;
  taskStatusBar: TaskStatusBarController;
  audit?: AuditLog;
  /** 主输出区 sink — sync shadow 的 tool_call/text_delta 路由到此 */
  sink?: DescriptorSink;
  /** 查 callerType / silent — shadow + silent 才进主输出区 */
  taskWatchMap?: Map<string, { callerType: string; silent: boolean }>;
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
  const SHADOW_TOOL_COLOR = '\x1b[36m';

  return (taskId: TaskId, event: TaskEvent) => {
    const tw = deps.taskWatchMap?.get(taskId);
    const isShadow = tw?.callerType === 'shadow';
    const isSilent = tw?.silent === true;

    switch (event.type) {
      case 'tool_call': {
        // sync shadow (silent) 的工具调用显示到主输出区
        if (isShadow && isSilent && deps.sink) {
          const toolName = String(event.name ?? '');
          deps.sink.emit({
            kind: 'text-line',
            color: SHADOW_TOOL_COLOR,
            text: `⚙ shadow:${toolName}`,
          });
        }
        // async shadow / 普通子代理进状态栏
        if (!isSilent) {
          deps.taskStatusBar.updateTrack(taskId, event);
        }
        break;
      }

      case 'text_delta': {
        // sync shadow 的文本输出路由到主输出区
        if (isShadow && isSilent && deps.sink) {
          const text = String(event.delta ?? '');
          if (text) {
            deps.sink.emit({ kind: 'text-line', color: '', text, wrap: true });
          }
        }
        if (!isSilent) {
          deps.taskStatusBar.updateTrack(taskId, event);
        }
        break;
      }

      case 'tool_result':
      case 'thinking_delta': {
        if (!isSilent) {
          deps.taskStatusBar.updateTrack(taskId, event);
        }
        break;
      }

      case 'turn_end':
      case 'turn_error':
      case 'turn_interrupted': {
        if (!isSilent) {
          deps.taskStatusBar.updateTrack(taskId, event);
        }
        deps.stopTaskWatch(taskId);
        break;
      }

      default: {
        deps.audit?.write(
          VIEWPORT_AUDIT_EVENTS.UNKNOWN_EVENT,
          `context=task_event`,
          `type=${String(event.type)}`,
          `taskId=${taskId}`,
        );
        break;
      }
    }
  };
}
