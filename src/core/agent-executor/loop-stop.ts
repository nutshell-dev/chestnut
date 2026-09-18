/**
 * @module L3.AgentExecutor.LoopStop
 * phase 1856 (AE-D10): typed loop stop request/outcome。
 *
 * 停止原因与结果引用进入契约 —— 替代裸 boolean（ctx.stopRequested）+ 伪造
 * 'end_turn' stopReason。真实停止原因（result capture 工具请求早停）有承载位置；
 * 消费方（subagent capture 路径）按 typed 字段识别。
 */

export interface LoopStopRequest {
  kind: 'result_capture';
  /* 未来 reason 扩展位 */
}
