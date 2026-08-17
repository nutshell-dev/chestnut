import type { PostProcessor } from '../../async-task-system/index.js';
import { SUMMON_AUDIT_EVENTS } from '../audit-events.js';
import { SUMMON_CALLER_TYPES } from '../caller-types.js';
import { formatErr } from '../../../foundation/node-utils/index.js';
import type { FileSystem } from '../../../foundation/fs/index.js';
import { isFileNotFound } from '../../../foundation/fs/index.js';
import type { RegisterRetrospectiveInput } from '../../evolution-system/index.js';
import { makeContractId } from '../../contract/index.js';
import type { SummonCreationClaimStore } from '../creation-claim-store.js';

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
 * Phase 1396 Step B 起 evidence 只作审计交叉验证（不再是创建 authority），
 * 读失败只产生 audit，不再改变判定。
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
 * Phase 1396 Step B: 只作审计交叉验证 —— 0/1 authority 是 creation claim + ContractSystem 核实。
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

function wrapFailureForMotion(rawResult: string): string {
  const RAW_OUTPUT_DIAGNOSTIC_MAX = 2000;
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
 * Phase 1396 Step B: 装配期注入的 ContractSystem 创建事实查询 capability。
 * 实现方按 executor 构造/复用 ContractSystem 并回答 contract 是否已提交
 * （active 或 archive）；SummonSystem 不直接读 contract 目录。
 */
export interface SummonContractQuery {
  exists(targetExecutorId: string, contractId: string): Promise<boolean>;
}

export interface SummonContractExtractDeps {
  /** SummonSystem 独占的 0/1 创建 claim store（读侧：恢复核实锚点） */
  claimStore: SummonCreationClaimStore;
  /** ContractSystem 创建事实查询 capability（装配期注入） */
  contractQuery: SummonContractQuery;
}

/**
 * summon-contract-extract PostProcessor factory.
 *
 * Phase 1396 Step B 重写判定 authority：
 * - success/error 两条路径都先读 creation claim，再经 ContractSystem query capability
 *   核实 {targetExecutorId, contractId} 是否已提交；
 * - claim + contract 已提交 → 成功（error envelope 同样恢复为成功，重建回执继续交付）；
 * - claim 存在但 contract 不存在 → 保持/判定失败（0/1 不变量：failed <=> 零个 contract）；
 * - 无 claim + success envelope → 失败（无创建事实记录）；
 * - 无 claim + error envelope → 透传上游 error；
 * - audit evidence scan 降级为审计交叉验证：发现第二个不同 contract evidence 或
 *   evidence 与 claim 不一致 → emit invariant violation（SUMMON_CREATION_EVIDENCE_MISMATCH）。
 *
 * 历史：
 * - phase 438 初立 marker 解析路径（寄生 LLM 文本）
 * - phase 1464 加 failure wrap framing（判 source 仍 LLM marker、根因未除）
 * - phase 1466 user reframe 重写 source / 判 source 改系统真相、保 wrap framing 复用
 * - phase 1206 Step D 改由 factory 注入 registerRetrospective、消除 legacy by-contract 写
 * - phase 1396 Step B 判定 authority 改 creation claim + ContractSystem 核实（0/1 不变量）
 */
export function createSummonContractExtractPostProcessor(
  registerRetrospective: (input: RegisterRetrospectiveInput) => Promise<void>,
  deps: SummonContractExtractDeps,
): PostProcessor {
  return async (result, task, isError, _fs, audit) => {
    const subAuditPath = `tasks/queues/results/${task.id}/audit.tsv`;

    // 1. claim 是创建事实的恢复锚点（success/error 两条路径都先读）
    const claim = await deps.claimStore.read(task.id);

    // 2. evidence scan 降级为审计交叉验证（读失败只 audit，不改判定）
    let evidence: ContractCreatedEvidence[] = [];
    try {
      evidence = await scanSubAuditForContracts(_fs, subAuditPath);
    } catch (err) {
      if (err instanceof SubAuditReadError) {
        audit.write(
          SUMMON_AUDIT_EVENTS.SUB_AUDIT_READ_FAILED,
          `taskId=${task.id}`,
          `path=${subAuditPath}`,
          `error=${formatErr(err.cause)}`,
        );
      } else {
        throw err;
      }
    }

    // 3. 交叉验证 invariant：至多一个 contract，且必须与 claim 一致
    const distinctEvidenceIds = [...new Set(evidence.map(e => e.contractId))];
    const mismatch =
      distinctEvidenceIds.length > 1 ||
      (!claim && distinctEvidenceIds.length > 0) ||
      (claim !== undefined && evidence.some(
        e => e.contractId !== claim.contractId || e.targetClaw !== claim.targetExecutorId,
      ));
    if (mismatch) {
      audit.write(
        SUMMON_AUDIT_EVENTS.SUMMON_CREATION_EVIDENCE_MISMATCH,
        `taskId=${task.id}`,
        `claimContractId=${claim?.contractId ?? '(none)'}`,
        `evidenceContractIds=${distinctEvidenceIds.join(',') || '(none)'}`,
      );
    }

    // 4. 无 claim：无创建事实记录
    if (!claim) {
      if (isError) return result;  // 上游 error envelope 已 explicit、不再二次 wrap
      audit.write(SUMMON_AUDIT_EVENTS.NO_CONTRACT_CREATED, `taskId=${task.id}`);
      return wrapFailureForMotion(result);
    }

    // 5. 有 claim：经 ContractSystem query capability 核实创建事实
    const exists = await deps.contractQuery.exists(claim.targetExecutorId, claim.contractId);
    if (!exists) {
      // 创建任务已终止且确认零 contract → summon failed（0/1 不变量失败侧）
      audit.write(
        SUMMON_AUDIT_EVENTS.SUMMON_CLAIM_CONTRACT_MISSING,
        `taskId=${task.id}`,
        `contractId=${claim.contractId}`,
        `targetExecutorId=${claim.targetExecutorId}`,
      );
      if (isError) return result;  // 保持 task failure
      return wrapFailureForMotion(result);
    }

    // 6. contract 已提交 → 成功事实成立（error envelope 恢复为成功、重建回执）
    if (isError) {
      audit.write(
        SUMMON_AUDIT_EVENTS.SUMMON_CREATION_RECOVERED,
        `taskId=${task.id}`,
        `contractId=${claim.contractId}`,
        `targetExecutorId=${claim.targetExecutorId}`,
      );
    }

    const mode: 'mining' | 'shadow' = task.callerType === SUMMON_CALLER_TYPES.MINER ? 'mining' : 'shadow';
    try {
      await registerRetrospective({
        contractId: makeContractId(claim.contractId),
        targetClaw: claim.targetExecutorId,
        mode,
        ...(mode === 'shadow' ? { shadowTaskId: task.id } : { miningTaskId: task.id }),
      });
    } catch (e) {
      audit.write(
        SUMMON_AUDIT_EVENTS.RETROSPECTIVE_REGISTRATION_FAILED,
        `taskId=${task.id}`,
        `contractId=${claim.contractId}`,
        `targetClaw=${claim.targetExecutorId}`,
        `error=${formatErr(e)}`,
      );
      // 契约已真创建：保留成功判定
    }

    return buildSuccessSummary(result, [
      { contractId: claim.contractId, targetClaw: claim.targetExecutorId },
    ]);
  };
}
