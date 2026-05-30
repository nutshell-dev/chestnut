import type { PostProcessor } from '../../async-task-system/post-processors/types.js';
import { SUMMON_AUDIT_EVENTS } from '../audit-events.js';
import { formatErr } from '../../../foundation/utils/index.js';
import type { FileSystem } from '../../../foundation/fs/types.js';

const RAW_OUTPUT_DIAGNOSTIC_MAX = 2000;

/**
 * exec 工具 audit row schema（`src/foundation/tools/executor.ts:222-228`）：
 *   <ts>\t<seq>\ttool_exec\t<toolName>\t<status>\telapsed_ms=<N>\tsummary=<escapeForLog(content)>
 *
 * CLI 成功创建契约时 stdout 写 `Contract created: <id> for claw <name>\n`（contract.ts:121）、
 * escapeForLog 把 `\n` 转字面 `\\n` 且 slice(0,120)、契约 ID + claw name 均在 120 chars 内。
 */
const CONTRACT_CREATED_SUMMARY = /^summary=Contract created: ([\w\-]+) for claw ([\w\-]+)/;

export interface ContractCreatedEvidence {
  contractId: string;
  targetClaw: string;
}

/**
 * 扫子代理 audit.tsv 提取所有 `Contract created: <id> for claw <name>` 凭证。
 * 系统真相驱动 / 不依赖 LLM 自报告。
 */
export async function scanSubAuditForContracts(
  fs: FileSystem,
  subAuditPath: string,
): Promise<ContractCreatedEvidence[]> {
  let content: string;
  try {
    content = await fs.read(subAuditPath);
  } catch {
    return [];  // audit 不存在 / 读失败 → 0 evidence、按失败处理
  }

  const evidence: ContractCreatedEvidence[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    const cols = line.split('\t');
    // [ts, seqN, eventType, toolName, status, elapsed_ms=N, summary=...]
    if (cols.length < 7) continue;
    if (cols[2] !== 'tool_exec') continue;
    if (cols[3] !== 'exec') continue;
    if (cols[4] !== 'ok') continue;
    const m = cols[6].match(CONTRACT_CREATED_SUMMARY);
    if (!m) continue;
    evidence.push({ contractId: m[1], targetClaw: m[2] });
  }
  return evidence;
}

function wrapFailureForMotion(rawResult: string): string {
  const truncated = rawResult.length > RAW_OUTPUT_DIAGNOSTIC_MAX
    ? rawResult.slice(0, RAW_OUTPUT_DIAGNOSTIC_MAX) + '\n... [truncated; 完整输出见 result.txt]'
    : rawResult;
  return [
    `[SUMMON_SHADOW_FAILED:no_contract_created]`,
    ``,
    `子代理完成但 0 次 contract create 成功（依据 subagent audit 系统真相）。最常见原因：弱模型脱离了契约创建流、用继承的工具直接执行了任务（未创建契约、目标 claw 未收到工作）。`,
    ``,
    `**建议路径**：`,
    `- 若原 goal 适合单次直接执行（不需要 claw 多步 / parallel / retrospective）：换 \`spawn\` 工具派子代理执行。`,
    `- 若必须走契约流（需要 claw 复用）：换强模型再 \`summon\`、或人工介入。`,
    ``,
    `--- raw subagent output (diagnostic only, NOT a completion signal) ---`,
    truncated,
  ].join('\n');
}

function buildSuccessSummary(rawResult: string, evidence: ContractCreatedEvidence[]): string {
  const trimmed = rawResult.trim() || '(empty subagent output)';
  const footer = [
    ``,
    `[CONTRACTS_CREATED]`,
    ...evidence.map(e => `- ${e.contractId} (claw=${e.targetClaw})`),
  ].join('\n');
  return trimmed + footer;
}

/**
 * summon-contract-extract PostProcessor
 *
 * phase 1466 重写：判定 source 从 LLM marker（`[CONTRACT_DONE]{...}`）改 subagent audit
 * `tool_exec exec ok summary=Contract created: <id> for claw <name>` 系统真相凭证。
 *
 * 应然原则：
 * - 不采用 LLM 自我声明（user 2026-05-30 ratify）
 * - 至少 1 次 contract create 成功 = 成功；0 次 = 失败（A1 ratify）
 * - 每条 evidence 独立 retro trigger（多契约独立 ratify）
 * - shadow 主动放弃 ≡ 失败（二态 ratify、reason 经 raw output 透传）
 *
 * 判定 / by-contract 写入 / summary 构造：
 * - subAudit 读 `tasks/queues/results/<task.id>/audit.tsv`、grep `Contract created:` 行提 evidence
 * - 0 evidence → wrap framing + spawn 建议 + raw output diagnostic
 * - ≥1 evidence → 每条 evidence 独立 by-contract trigger 文件 + clean summary 附 [CONTRACTS_CREATED] 段
 *
 * 历史：
 * - phase 438 初立 marker 解析路径（寄生 LLM 文本）
 * - phase 1464 加 failure wrap framing（判 source 仍 LLM marker、根因未除）
 * - phase 1466 user reframe 重写 source / 判 source 改系统真相、保 wrap framing 复用
 */
export const summonContractExtractPostProcessor: PostProcessor = async (
  result, task, isError, fs, audit,
) => {
  if (isError) return result;  // 上游 error envelope 已 explicit、不再二次 wrap

  const subAuditPath = `tasks/queues/results/${task.id}/audit.tsv`;
  const evidence = await scanSubAuditForContracts(fs, subAuditPath);
  const mode: 'mining' | 'shadow' = task.callerType === 'miner' ? 'mining' : 'shadow';

  if (evidence.length === 0) {
    audit.write(SUMMON_AUDIT_EVENTS.NO_CONTRACT_CREATED, `taskId=${task.id}`);
    return wrapFailureForMotion(result);
  }

  // ≥1 evidence: 写 retro trigger per evidence（多契约独立）
  try {
    await fs.ensureDir('clawspace/pending-retrospective/by-contract');
  } catch (e) {
    audit.write(
      SUMMON_AUDIT_EVENTS.WRITE_BY_CONTRACT_FAILED,
      `taskId=${task.id}`,
      `phase=ensureDir`,
      `error=${formatErr(e)}`,
    );
    return buildSuccessSummary(result, evidence);  // 即使 retro 注册失败、契约真创建了、不改判定
  }

  for (const { contractId, targetClaw } of evidence) {
    try {
      await fs.writeAtomic(
        `clawspace/pending-retrospective/by-contract/${contractId}.json`,
        JSON.stringify({
          contractId,
          targetClaw,
          createdAt: new Date().toISOString(),
          mode,
          ...(mode === 'shadow' ? { shadowTaskId: task.id } : { miningTaskId: task.id }),
        }),
      );
    } catch (e) {
      audit.write(
        SUMMON_AUDIT_EVENTS.WRITE_BY_CONTRACT_FAILED,
        `contractId=${contractId}`,
        `error=${formatErr(e)}`,
      );
    }
  }

  return buildSuccessSummary(result, evidence);
};
