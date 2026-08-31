import type { PostProcessor, ProcessedTaskResult } from '../../async-task-system/index.js';
import { SUMMON_AUDIT_EVENTS } from '../audit-events.js';
import { formatErr } from '../../../foundation/node-utils/index.js';
import type { FileSystem } from '../../../foundation/fs/index.js';
import { isFileNotFound } from '../../../foundation/fs/index.js';
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

interface ContractCreatedEvidence {
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

/**
 * Phase 1396 Step C: 统一失败 envelope 标记。
 * summon 失败 = contract 创建未完成（reason 一行、不含内部恢复处方）。
 */
export const SUMMON_CONTRACT_CREATION_FAILED_ERROR = 'summon_contract_creation_failed' as const;

function buildFailureResult(reason: string): ProcessedTaskResult {
  return {
    schema_version: 1,
    content: `Summon failed (${SUMMON_CONTRACT_CREATION_FAILED_ERROR}): ${reason}`,
    isError: true,
    metadata: { reason },
  };
}

/**
 * Phase 1396 Step C/J: 成功结果精确返回一个 contractId ——
 * 不含 executor、不含内部 mode、不含 raw 执行输出（可能夹带内部实体名）。
 */
function buildSuccessResult(contractId: string): ProcessedTaskResult {
  return {
    schema_version: 1,
    content: `Contract created: ${contractId}`,
    isError: false,
    metadata: { contractId },
  };
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
 * - 无 claim → 失败（无创建事实记录；error envelope 的失败 reason 同样以创建事实为准）；
 * - audit evidence scan 降级为审计交叉验证：发现第二个不同 contract evidence 或
 *   evidence 与 claim 不一致 → emit invariant violation（SUMMON_CREATION_EVIDENCE_MISMATCH）。
 *
 * Phase 1396 Step M: summon 在 contract 创建事实确认后即结束 ——
 * 不再注册 retrospective、不调 EvolutionSystem；contract completed 后的复盘由
 * ContractObserver 观察 archive 事实并交给 EvolutionSystem 自行 own。
 *
 * 历史：
 * - phase 438 初立 marker 解析路径（寄生 LLM 文本）
 * - phase 1464 加 failure wrap framing（判 source 仍 LLM marker、根因未除）
 * - phase 1466 user reframe 重写 source / 判 source 改系统真相、保 wrap framing 复用
 * - phase 1206 Step D 改由 factory 注入 registerRetrospective、消除 legacy by-contract 写
 * - phase 1396 Step B 判定 authority 改 creation claim + ContractSystem 核实（0/1 不变量）
 * - phase 1396 Step C 最终结果收缩：成功 = `Contract created: <id>`，失败 = 统一
 *   `summon_contract_creation_failed` envelope；不含 executor/mode/raw 输出
 * - phase 1396 Step M 移除 retrospective 注册（创建完成即终止）
 */
export function createSummonContractExtractPostProcessor(
  deps: SummonContractExtractDeps,
): PostProcessor {
  return async ({ content: _content, sourceIsError }, task, _fs, audit) => {
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
      audit.write(SUMMON_AUDIT_EVENTS.NO_CONTRACT_CREATED, `taskId=${task.id}`);
      return buildFailureResult('no_contract_created');
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
      return buildFailureResult('contract_not_committed');
    }

    // 6. contract 已提交 → 成功事实成立（error envelope 恢复为成功、重建回执）。
    // Phase 1396 Step M: 此分支后不得有任何外部调用 —— 创建完成即 SummonSystem 终点。
    if (sourceIsError) {
      audit.write(
        SUMMON_AUDIT_EVENTS.SUMMON_CREATION_RECOVERED,
        `taskId=${task.id}`,
        `contractId=${claim.contractId}`,
        `targetExecutorId=${claim.targetExecutorId}`,
      );
    }

    return buildSuccessResult(claim.contractId);
  };
}
