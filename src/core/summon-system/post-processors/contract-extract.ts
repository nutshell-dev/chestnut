import type { PostProcessor } from '../../async-task-system/post-processors/types.js';
import { SUMMON_AUDIT_EVENTS } from '../audit-events.js';
import { SUMMON_CALLER_TYPES } from '../caller-types.js';
import { formatErr } from '../../../foundation/node-utils/index.js';
import type { FileSystem } from '../../../foundation/fs/index.js';
import { isFileNotFound } from '../../../foundation/fs/index.js';

/**
 * post-processor 失败 audit 时附带的 raw output 最大字符数（diagnostic 截断 cap）.
 * Derivation: 2000 char ≈ 1-2 page LLM raw response / 足够诊断 contract 提取失败原因
 * 但不致 audit row 膨胀过大（audit.tsv 单行 ≈ 80 col × 25 line / 单 col 不超此）.
 */
const RAW_OUTPUT_DIAGNOSTIC_MAX = 2000;

/**
 * PostProcessor 注册名 — Assembly 装配期 addPostProcessor 用、
 * tasks.json `postProcessor` 字段写入、subagent-helpers 分支判断用。
 * canonical owner = post-processors/contract-extract.ts（M#3）
 */
export const SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME = 'summon-contract-extract' as const;

/**
 * exec 工具 audit row schema（`src/foundation/tools/executor.ts:222-228`）：
 *   <ts>\t<seq>\ttool_exec\t<toolName>\t<status>\telapsed_ms=<N>\tsummary=<audit.message(content)>
 *
 * CLI 成功创建契约时 stdout 写 `Contract created: <id> for claw <name>\n`（contract.ts:121）、
 * audit.message(content) 截断到 200 chars、契约 ID + claw name 均在 200 chars 内。
 */
const CONTRACT_CREATED_SUMMARY = /^summary=Contract created: ([\w\-]+) for claw ([\w\-]+)/;

export interface ContractCreatedEvidence {
  contractId: string;
  targetClaw: string;
}

/**
 * phase 1129 P1-16: scanSubAuditForContracts 非 FNF 读失败时抛出的 typed error。
 * 与 wrapFailureForMotion 的 0-evidence 语义区分：audit 可读性故障 ≠ 0 契约创建。
 */
export class SubAuditReadError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    super(`sub-audit read failed: ${path}`);
  }
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
  } catch (err) {
    if (isFileNotFound(err)) return [];  // audit 不存在 = 良性 0 evidence
    // phase 1129 P1-16: 非 FNF 读失败 ≠「0 契约创建」——caller 需走 audit 读失败分支
    throw new SubAuditReadError(subAuditPath, err);
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

function wrapAuditReadFailureForMotion(rawResult: string, subAuditPath: string): string {
  const truncated = rawResult.length > RAW_OUTPUT_DIAGNOSTIC_MAX
    ? rawResult.slice(0, RAW_OUTPUT_DIAGNOSTIC_MAX) + '\n... [truncated; 完整输出见 result.txt]'
    : rawResult;
  return [
    `[SUMMON_SHADOW_UNCERTAIN:audit_read_failed]`,
    ``,
    `子代理 audit 读取失败（非「0 契约创建」）：契约状态不确定。`,
    ``,
    `**Motion 必须立即执行**：先核实契约是否已创建（contract 查询确认）；`,
    `未创建才可用 summon mining 模式重试。**不要直接用 mining 重试——契约可能已建、重试会重复创建。**`,
    ``,
    `失败路径：${subAuditPath}`,
    ``,
    `--- raw subagent output（diagnostic only、不是完成信号、不要转发） ---`,
    truncated,
  ].join('\n');
}

function wrapFailureForMotion(rawResult: string): string {
  const truncated = rawResult.length > RAW_OUTPUT_DIAGNOSTIC_MAX
    ? rawResult.slice(0, RAW_OUTPUT_DIAGNOSTIC_MAX) + '\n... [truncated; 完整输出见 result.txt]'
    : rawResult;
  return [
    `[SUMMON_SHADOW_FAILED:no_contract_created]`,
    ``,
    `子代理违反 shadow 协议：完成但 0 次 contract create。`,
    ``,
    `**Motion 必须立即执行**：`,
    `用 \`summon\` 工具的 \`mining\` 模式重试本次任务。不要把下方 raw output 转发给用户、不要从中提取信息当结果。`,
    ``,
    `**为什么 raw output 不可信**：`,
    `它来自一个违反协议的子代理（应当委派给 target claw、实然自跑了任务）。即使内容看似合理、它没有经过 target claw 验证、不是有效完成证据。post-processor 已判失败、本次任务的真实状态 = 未完成。`,
    ``,
    `--- raw subagent output（diagnostic only、不是完成信号、不要转发） ---`,
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
  let evidence: ContractCreatedEvidence[];
  try {
    evidence = await scanSubAuditForContracts(fs, subAuditPath);
  } catch (err) {
    if (err instanceof SubAuditReadError) {
      audit.write(
        SUMMON_AUDIT_EVENTS.SUB_AUDIT_READ_FAILED,
        `taskId=${task.id}`,
        `path=${subAuditPath}`,
        `error=${formatErr(err.cause)}`,
      );
      return wrapAuditReadFailureForMotion(result, subAuditPath);
    }
    throw err;
  }
  const mode: 'mining' | 'shadow' = task.callerType === SUMMON_CALLER_TYPES.MINER ? 'mining' : 'shadow';

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
