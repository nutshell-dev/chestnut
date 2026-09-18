/**
 * subagent steps.jsonl entry shape 入口 schema invariant。
 *
 * 应然 anchor（per design/modules/l3_subagent.md §「persist-state observability」、phase 270 Step A）：
 * - DP1 信息不丢失：steps.jsonl 是 subagent step 进展权威记录、shape 漂 = forensic 解析失败
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * 4 sub-check（entry shape `{step: number, ts: ISO timestamp, tools: string[], elapsedMs: number}`）：
 * - step: number (非负整数)
 * - ts: string + ISO 8601 timestamp 形态
 * - tools: string[] (元素 string)
 * - elapsedMs: number (非负整数)
 *
 * 不 throw（DP1 + Path #4 防 break subagent run 路径 + 保既有 STEP_COMPLETE_FAILED 路径）。
 *
 * phase 1858 Step K (SA-D10): 消费面收窄为 StepsInvariantSink（ISP：仅需 steps 不变量写点）；
 * 事件字符串 / 列格式由 lifecycle-sink adapter 保持。
 */

import type { StepsInvariantSink } from './lifecycle-sink.js';

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function assertStepsEntryShape(
  entry: unknown,
  sink: StepsInvariantSink,
): void {
  if (typeof entry !== 'object' || entry === null) {
    sink.stepsInvariantViolated({ kind: 'entry_not_object', actual: typeof entry });
    return;
  }
  const e = entry as Record<string, unknown>;
  checkStep(e, sink);
  checkTs(e, sink);
  checkTools(e, sink);
  checkElapsedMs(e, sink);
}

function checkStep(e: Record<string, unknown>, sink: StepsInvariantSink): void {
  if (typeof e.step !== 'number' || !Number.isInteger(e.step) || e.step < 0) {
    sink.stepsInvariantViolated({ kind: 'step_invalid', actual: String(e.step) });
  }
}

function checkTs(e: Record<string, unknown>, sink: StepsInvariantSink): void {
  if (typeof e.ts !== 'string') {
    sink.stepsInvariantViolated({ kind: 'ts_not_string', actual: typeof e.ts });
    return;
  }
  if (!ISO_TIMESTAMP_REGEX.test(e.ts)) {
    sink.stepsInvariantViolated({ kind: 'ts_not_iso', actual: e.ts });
  }
}

function checkTools(e: Record<string, unknown>, sink: StepsInvariantSink): void {
  if (!Array.isArray(e.tools)) {
    sink.stepsInvariantViolated({ kind: 'tools_not_array', actual: typeof e.tools });
    return;
  }
  const nonStrIdx = e.tools.findIndex(x => typeof x !== 'string');
  if (nonStrIdx >= 0) {
    sink.stepsInvariantViolated({
      kind: 'tools_element_not_string',
      idx: nonStrIdx,
      actual: typeof e.tools[nonStrIdx],
    });
  }
}

function checkElapsedMs(e: Record<string, unknown>, sink: StepsInvariantSink): void {
  if (typeof e.elapsedMs !== 'number' || !Number.isInteger(e.elapsedMs) || e.elapsedMs < 0) {
    sink.stepsInvariantViolated({ kind: 'elapsedMs_invalid', actual: String(e.elapsedMs) });
  }
}
