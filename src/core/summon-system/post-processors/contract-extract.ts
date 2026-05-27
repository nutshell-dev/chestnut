import type { PostProcessor } from '../../async-task-system/post-processors/types.js';
import { SUMMON_AUDIT_EVENTS } from '../audit-events.js';
import { formatErr } from '../../../foundation/utils/format.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../../../foundation/audit/index.js';


/**
 * summon-contract-extract PostProcessor
 *
 * 业务：summoner 子代理（miner / shadow）run 完后 / 提取 [CONTRACT_DONE] block /
 * 写 by-contract 文件 / 返清洁 summary（替代 closure 注册模式 / phase 438 立项）
 *
 * 移自 src/core/task/tools/dispatch.ts:106-162 closure 1:1 业务 logic
 *
 * 关键 derive:
 * - summonerTaskId → task.id（不需要外部传 / postProcessor 接 task 即知）
 * - mode → task.callerType derive（'miner'→mining / 'shadow'→shadow）
 * - removeHandler → 不需要（postProcessor 单次执行 / 0 注销生命周期）
 */
export const summonContractExtractPostProcessor: PostProcessor = async (
  result, task, isError, fs, audit,
) => {
  if (isError) return result;  // error path 0 处理 / 等同当前 closure 实质行为

  const blockMatch = result.match(/\[CONTRACT_DONE\]\s*(\{[\s\S]*?\})\s*\[\/CONTRACT_DONE\]/);
  if (!blockMatch) {
    audit.write(SUMMON_AUDIT_EVENTS.CONTRACT_DONE_NOT_FOUND, `taskId=${task.id}`);
    return result;
  }

  let parsed: { contractId?: string; targetClaw?: string };
  try {
    parsed = JSON.parse(blockMatch[1]);
  } catch {
    audit.write(SUMMON_AUDIT_EVENTS.CONTRACT_DONE_PARSE_FAILED, `raw=${blockMatch[1].slice(0, AUDIT_MESSAGE_MAX_CHARS)}`);
    return result;
  }

  const { contractId, targetClaw } = parsed;
  if (typeof contractId !== 'string' || typeof targetClaw !== 'string') {
    audit.write(
      SUMMON_AUDIT_EVENTS.CONTRACT_DONE_MISSING_FIELDS,
      `taskId=${task.id}`,
      `contractId=${parsed.contractId ?? 'missing'}`,
      `targetClaw=${parsed.targetClaw ?? 'missing'}`,
    );
    return result;
  }

  // mode derive 自 task.callerType（'miner'→mining / 'shadow'→shadow）
  const mode: 'mining' | 'shadow' = task.callerType === 'miner' ? 'mining' : 'shadow';

  try {
    await fs.ensureDir('clawspace/pending-retrospective/by-contract');
    await fs.writeAtomic(
      `clawspace/pending-retrospective/by-contract/${contractId}.json`,
      JSON.stringify({
        contractId,
        targetClaw,
        createdAt: new Date().toISOString(),
        mode,
        ...(mode === 'shadow'
          ? { shadowTaskId: task.id }
          : { miningTaskId: task.id }),
      }),
    );
  } catch (e) {
    audit.write(
      SUMMON_AUDIT_EVENTS.WRITE_BY_CONTRACT_FAILED,
      `contractId=${contractId}`,
      `error=${formatErr(e)}`,
    );
  }

  const summary = result.replace(/\[CONTRACT_DONE\][\s\S]*?\[\/CONTRACT_DONE\]/g, '').trim();
  return summary || `契约已创建（contractId: ${contractId}，targetClaw: ${targetClaw}）。`;
};
