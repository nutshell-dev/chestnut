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
import type { TaskId } from '../../core/async-task-system/index.js';
import type { StreamEvent } from '../../foundation/stream/index.js';


export interface TaskEventHandlerDeps {
  stopTaskWatch: (taskId: TaskId) => void;
  taskStatusBar: TaskStatusBarController;
  audit?: AuditLog;
}

export type TaskEvent = StreamEvent;

export function createTaskEventHandler(deps: TaskEventHandlerDeps) {
  return (taskId: TaskId, event: StreamEvent) => {
    switch (event.type) {
      case 'tool_call':
      case 'tool_result':
      case 'thinking_delta':
      case 'text_delta': {
        deps.taskStatusBar.updateTrack(taskId, event);
        break;
      }

      case 'turn_end':
      case 'turn_error':
      case 'turn_interrupted': {
        deps.taskStatusBar.updateTrack(taskId, event);
        deps.stopTaskWatch(taskId);
        break;
      }

      case 'llm_retry_waiting':
      case 'provider_attempt_failed':
      case 'retry_scheduled': {
        // Phase 1268 Step D: task 流内 LLM 调度/重试事件 → 状态条摘要（不落 UNKNOWN audit）
        deps.taskStatusBar.updateTrack(taskId, event);
        break;
      }

      // 非消费类型显式声明：保持原 default 的 UNKNOWN audit
      case 'turn_start': case 'llm_start': case 'text_end':
      case 'tool_use_input': case 'user_reply_delta': case 'user_reply_end':
      case 'provider_info': case 'provider_failover': case 'provider_failed':
      case 'provider_exhausted': case 'fallback_switched': case 'breaker_opened':
      case 'breaker_half_open': case 'breaker_closed': case 'healthcheck_failed':
      case 'stream_reset': case 'stream_parse_error': case 'tool_arg_parse_error':
      case 'idle_failover_triggered': case 'stream_idle_probe_attempted': case 'stream_idle_probe_succeeded':
      case 'context_exceeded_failover': case 'context_exceeded_throwthrough': case 'permanent_skip_retry':
      case 'hedge_started': case 'hedge_primary_recovered': case 'hedge_primary_post_first_chunk_failure':
      case 'hedge_fallback_committed': case 'hedge_primary_succeeded_after_race_lost':
      case 'all_providers_context_exceeded': case 'race_loser_cleaned':
      case 'sdk_client_cache_hit': case 'sdk_client_cache_miss': case 'provider_close_failed':
      case 'user_notify':
      case 'session_boundary': case 'daemon_started':
      case 'task_started': case 'task_completed': case 'task_attempt_start': {
        deps.audit?.write(
          VIEWPORT_AUDIT_EVENTS.UNKNOWN_EVENT,
          `context=task_event`,
          `type=${String(event.type)}`,
          `taskId=${taskId}`,
        );
        break;
      }

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };
}
