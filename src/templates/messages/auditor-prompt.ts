/**
 * M18 提示词片段：契约审计子代理系统提示词。
 * 触发/接收者：ContractAuditor 周期审计 LLM 调用 → auditor 子代理 system prompt。
 * 原 owner：core/contract/contract-auditor.ts（审计调度、限流、输入组装与
 * drift 反馈投递仍归原 owner；提示词字面归本目录单源）。
 */

/* ------------------------------------------------------------------ */
/* phase 1909 Step C：AUDITOR_SYSTEM_PROMPT 迁入模板单源                */
/* （机械迁移，逐字节不变；语义测试做逐字节断言防顺手润色）。              */
/* ------------------------------------------------------------------ */

export const AUDITOR_SYSTEM_PROMPT = `You are a contract auditor for an autonomous AI agent. Read recent activity, compare to contract expectations, and report either "on_track" or specific drifts. Output strict JSON only.`;
