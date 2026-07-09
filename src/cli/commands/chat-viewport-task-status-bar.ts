/**
 * @module L6.CLI.ChatViewport.TaskStatusBar
 * 异步 spawn/shadow 状态条聚合 + render
 * phase 810 落地 phase 802 §7.B GView-1 至 GView-8 ratify
 *
 * 5 维 ratify:
 *   - 数据源 = task stream（已订阅、复用 GView-1 α）
 *   - 单条结构 = 单行紧凑同 clawLine（GView-2 α）
 *   - 内部 file 边界 = 单 file（GView-8 α）
 *   - 新创建 unshift 在 head（GView-6 α 新在堆顶）
 *   - 完成立即移除（GView-5 ε）
 *   - 严格分两组（spawn 加 shadow 独立 Map、render 2 Text、GView-7 α 的 viewport 端落地）
 */

import { fitLine } from '../utils/string.js';
// phase 1490: TaskTrack.maxSteps 初值不再 import DEFAULT_MAX_STEPS — UI render 不显示该字段、event 驱动更新（line 119）即填真值。
import type { TaskId } from '../../core/async-task-system/types.js';

/** chat-viewport task line shortId 显示截断 cap（viewport UI 业务、与 UUID_SHORT_LEN=8 独立可变）*/
const VIEWPORT_TASK_ID_DISPLAY_CHARS = 6;

export interface TaskTrack {
  taskId: TaskId;
  callerType: 'spawn_subagent' | 'shadow_subagent';   // 'spawn_subagent' 归 spawn 数组、'shadow_subagent' 归 shadow 数组
  currentTool: string | null;
  toolSuccess: boolean | null;
  textBuffer: string;
  bufferType: 'thinking' | 'text' | null;
  step: number;
  maxSteps: number;
  lastError: string | null;
}

export function makeTaskTrack(taskId: TaskId, callerType: 'spawn_subagent' | 'shadow_subagent'): TaskTrack {
  return {
    taskId,
    callerType,
    currentTool: null,
    toolSuccess: null,
    textBuffer: '',
    bufferType: null,
    step: 0,
    maxSteps: 0,
    lastError: null,
  };
}

export function buildTaskLine(t: TaskTrack, cols: number): string {
  const shortId = t.taskId.slice(0, VIEWPORT_TASK_ID_DISPLAY_CHARS);
  const prefix = t.callerType === 'spawn_subagent' ? 'spawn-' : 'shadow-';
  const label = `${prefix}${shortId}`;
  const icon = t.toolSuccess === true ? '✓' : t.toolSuccess === false ? '✗' : '⚙';
  if (t.currentTool) {
    if (t.textBuffer) {
      const isThinking = t.bufferType === 'thinking';
      const open = isThinking ? '(' : '"';
      const close = isThinking ? ')' : '"';
      const line = `[${label}] ${icon} ${t.currentTool} · ${open}${t.textBuffer.trimStart().replace(/\n/g, ' ')}${close}`;
      return `\x1b[38;5;147m${fitLine(line, cols)}\x1b[0m`;
    }
    return `\x1b[38;5;147m[${label}] ${icon} ${t.currentTool}\x1b[0m`;
  }
  const inner = t.textBuffer ? t.textBuffer.trimStart().replace(/\n/g, ' ') : '';
  return `\x1b[38;5;147m${fitLine(`[${label}] ⊙ (${inner})`, cols)}\x1b[0m`;
}

export interface TaskStatusBarDeps {
  updateRender: () => void;   // debounced render trigger（与 attachedClawBar 同 nextTick 模式）
}

export interface MigratedExecTrack {
  taskId: TaskId;
  command: string;
  startedAt: number;  // ms epoch
}

export interface TaskStatusBarController {
  addTrack(taskId: TaskId, callerType: string): void;
  removeTrack(taskId: TaskId): void;
  updateTrack(taskId: TaskId, event: { type: string; [key: string]: unknown }): void;
  addMigratedExec(track: MigratedExecTrack): void;
  removeMigratedExec(taskId: TaskId): void;
  renderSpawn(cols: number): string;   // 多行 join、堆顶 = 数组 head
  renderShadow(cols: number): string;
  renderMigratedExec(cols: number): string;
  hasAny(): boolean;
}

function renderMigratedExecLine(track: MigratedExecTrack, cols: number): string {
  const elapsedMin = Math.floor((Date.now() - track.startedAt) / 60_000);
  const elapsedLabel = `${elapsedMin}m`;
  const line = `⚙ exec ${elapsedLabel}  · ${track.command}`;
  return `\x1b[38;5;147m${fitLine(line, cols)}\x1b[0m`;
}

export function createTaskStatusBar(deps: TaskStatusBarDeps): TaskStatusBarController {
  // 严格分两组 Map（GView-7 α 的 data 层）
  const spawnTracks: TaskTrack[] = [];   // head = 堆顶 = 视觉最上
  const shadowTracks: TaskTrack[] = [];
  // Phase 833: migrated exec tasks run independently of spawn/shadow subagents.
  const migratedExecTracks: MigratedExecTrack[] = [];

  const findIndex = (arr: TaskTrack[], taskId: TaskId) => arr.findIndex(tr => tr.taskId === taskId);
  const findMigratedIndex = (taskId: TaskId) => migratedExecTracks.findIndex(tr => tr.taskId === taskId);

  const addTrack = (taskId: TaskId, callerType: string) => {
    const isShadow = callerType === 'shadow_subagent';
    const track = makeTaskTrack(taskId, isShadow ? 'shadow_subagent' : 'spawn_subagent');
    const arr = isShadow ? shadowTracks : spawnTracks;
    arr.unshift(track);   // GView-6 α 新在堆顶
    deps.updateRender();
  };

  const removeTrack = (taskId: TaskId) => {
    let idx = findIndex(spawnTracks, taskId);
    if (idx >= 0) { spawnTracks.splice(idx, 1); deps.updateRender(); return; }
    idx = findIndex(shadowTracks, taskId);
    if (idx >= 0) { shadowTracks.splice(idx, 1); deps.updateRender(); return; }
  };

  const find = (taskId: TaskId): TaskTrack | undefined => {
    return spawnTracks.find(tr => tr.taskId === taskId) ?? shadowTracks.find(tr => tr.taskId === taskId);
  };

  const updateTrack = (taskId: TaskId, event: { type: string; [key: string]: unknown }) => {
    const tr = find(taskId);
    if (!tr) return;   // 未注册 task 不处理
    switch (event.type) {
      case 'tool_call':
        // phase 940 r117 B fork (phase 928 design): null-sentinel for absent tool name
        // 修 silent X: event.name undefined → '' (falsy) → line 47 truthy 检漏 → ⊙ ghost branch
        tr.currentTool = event.name ? String(event.name) : null;
        tr.toolSuccess = null;
        tr.textBuffer = '';
        tr.bufferType = null;
        break;
      case 'tool_result':
        tr.toolSuccess = Boolean(event.success);
        tr.step = Number(event.step ?? tr.step);
        tr.maxSteps = Number(event.maxSteps ?? tr.maxSteps);
        break;
      case 'thinking_delta':
        tr.textBuffer += String(event.delta ?? '');
        tr.bufferType = 'thinking';
        break;
      case 'text_delta':
        tr.textBuffer += String(event.delta ?? '');
        tr.bufferType = 'text';
        break;
      case 'turn_end':
      case 'turn_error':
      case 'turn_interrupted':
        // 立即移除（GView-5 ε、不延迟淡出）
        removeTrack(taskId);
        return;
      default:
        return;
    }
    deps.updateRender();
  };

  const addMigratedExec = (track: MigratedExecTrack) => {
    const idx = findMigratedIndex(track.taskId);
    if (idx >= 0) {
      // Re-use slot if the same taskId arrives again (defensive).
      migratedExecTracks[idx] = track;
    } else {
      migratedExecTracks.unshift(track);   // newest at head, matching spawn/shadow
    }
    deps.updateRender();
  };

  const removeMigratedExec = (taskId: TaskId) => {
    const idx = findMigratedIndex(taskId);
    if (idx >= 0) {
      migratedExecTracks.splice(idx, 1);
      deps.updateRender();
    }
  };

  const renderSpawn = (cols: number) => spawnTracks.map(t => buildTaskLine(t, cols)).join('\n');
  const renderShadow = (cols: number) => shadowTracks.map(t => buildTaskLine(t, cols)).join('\n');
  const renderMigratedExec = (cols: number) => migratedExecTracks.map(t => renderMigratedExecLine(t, cols)).join('\n');
  const hasAny = () => spawnTracks.length > 0 || shadowTracks.length > 0 || migratedExecTracks.length > 0;

  return { addTrack, removeTrack, updateTrack, addMigratedExec, removeMigratedExec, renderSpawn, renderShadow, renderMigratedExec, hasAny };
}
