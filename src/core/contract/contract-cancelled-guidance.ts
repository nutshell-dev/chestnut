/**
 * @module L4.ContractSystem
 * phase 1262 Step A: ContractSystem-owned `contract_cancelled` guidance codec.
 *
 * 业主 (core/contract) 独占 contract cancelled guidance 事实与其持久化 wire schema：
 * - producer（Assembly contract-notification-adapter 的 single path 与
 *   contract-observer cron 的 batch path）只经 {@link encodeContractCancelledGuidance}
 *   产生 `extraFields`，不再手写 `source_claw` / `contract_id` / `reason` /
 *   `cancellations` 两套无版本 legacy dialect；
 * - consumer（Assembly guidance composer）只经 {@link decodeContractCancelledGuidance}
 *   读取 typed refs，不再自行 JSON.parse / 逐项静默过滤 malformed entry /
 *   伪造 `(unknown)` / `(no reason given)` 默认值。
 *
 * v1 wire 精确两字段：
 *   guidance_schema_version: "1"
 *   cancelled_contract_refs: '[{"claw_id":"worker-1","contract_id":"c1"}]'
 * `cancelled_contract_refs` 是 canonical JSON array，**必须 non-empty**（两个
 * production writer 均一事件一 ref，空 refs 没有真实业务来源、只表示损坏；
 * 与 contract_events 空 refs 合法是独立的 owner schema 决策，不做表面一致化）。
 *
 * v1 refs 只传渲染所需的 claw/contract ID：reason 已完整持久化在同一 inbox body
 * （single 还在 stream），guidance presentation 完全不消费，不重复跨边界。
 *
 * M#4: inbox 可跨重启恢复 → 显式 schema version + legacy read + unknown-version
 * failure 都是协议的一部分。当前 writer 总写 v1；decoder 同时读取两类缺 version 的
 * 真实 legacy production shape（adapter single / observer cancellations JSON batch），
 * 拒绝未知版本。legacy batch 任一 malformed entry 整条 typed throw（不再部分过滤：
 * 部分过滤静默丢磁盘事实且无法从日志重建被忽略项；Runtime 保证正文继续交付并
 * audit guidance 失败）。legacy entry 必须携带 non-empty reason —— 两个 production
 * writer 始终写 non-empty reason，缺失表示磁盘 shape 不完整，不得默认掩盖。
 *
 * ID 约束沿用现存 wire 防注入规则 `^[A-Za-z0-9_-]{1,64}$`（phase 324 H11）：
 * brand 只表达 owner 类型、不验证外部/历史磁盘值，故 encode/decode boundary 各自校验。
 * 与 contract-events-guidance.ts 的相同 regex 保持 codec-local、不抽 helper
 * （规则属于各自 persisted schema、可独立演进）。
 *
 * 本文件保持纯函数、零 runtime resource/import，供 Assembly composer 以
 * protocol-only 方式 import（同 contract-events-guidance.ts 模式）。
 */

import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { makeContractId } from './types.js';
import type { ContractId } from './types.js';

/** 当前 writer 持久化的 schema version（string wire value）。 */
const CONTRACT_CANCELLED_GUIDANCE_SCHEMA_VERSION = '1' as const;

/** owner-local wire key（metadata key，仅此文件声明）。 */
const WIRE_KEYS = {
  version: 'guidance_schema_version',
  cancelledRefs: 'cancelled_contract_refs',
} as const;

/** legacy（缺 version）production shape 的两套 dialect key。 */
const LEGACY_KEYS = {
  sourceClaw: 'source_claw',
  contractId: 'contract_id',
  reason: 'reason',
  cancellations: 'cancellations',
} as const;

/** wire envelope type 字面（两条 production path 共用；decoder 据此拒绝非本 type）。 */
const WIRE_TYPE = 'contract_cancelled';

/** sender 唯一：两条 production path 均 `from='system'`（owner provenance）。 */
const WIRE_FROM = 'system';

/** 单条 cancelled contract guidance reference（typed owner fact）。 */
export interface ContractCancelledGuidanceRef {
  readonly clawId: ClawId;
  readonly contractId: ContractId;
}

/** decoder 产出的 typed state（consumer 唯一依赖的稳定形状）。 */
export interface ContractCancelledGuidanceState {
  readonly schemaVersion: 1;
  readonly contractRefs: readonly ContractCancelledGuidanceRef[];
}

/**
 * decoder 最小结构化入参 — 本地声明、禁止 import Assembly。
 * 与 Runtime `GuidanceEnvelope { type, from, meta }` structural 兼容。
 */
export interface ContractCancelledGuidanceWire {
  readonly type: string;
  readonly from: string;
  readonly meta: Readonly<Record<string, string>>;
}

export type ContractCancelledGuidanceDecodeErrorReason =
  | 'unknown_schema_version'
  | 'schema_invalid';

/**
 * malformed/unknown wire 的 typed error。
 * message 只含 type/version/field/reason，不回显 metadata、refs JSON 或取消原因内容。
 */
export class ContractCancelledGuidanceDecodeError extends Error {
  readonly reason: ContractCancelledGuidanceDecodeErrorReason;
  readonly field: string | undefined;

  constructor(
    reason: ContractCancelledGuidanceDecodeErrorReason,
    detail: string,
    field?: string,
  ) {
    super(`contract_cancelled guidance decode failed: reason=${reason}${field ? ` field=${field}` : ''} ${detail}`);
    this.name = 'ContractCancelledGuidanceDecodeError';
    this.reason = reason;
    this.field = field;
  }
}

// phase 324 H11: 严格 id 字符集、拒含 `:` `,` `` ` `` `\n` 等可注入 CLI / markdown 的字符。
const GUIDANCE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function isGuidanceId(value: string): boolean {
  return GUIDANCE_ID_REGEX.test(value);
}

/**
 * producer 侧 encode：typed refs → wire `extraFields`（总写 v1 精确两字段）。
 * refs 必须 non-empty（无真实业务来源的空 refs 只表示损坏）；逐项执行 safe ID
 * 校验；wire 只含 owner 两 key、不持有输入引用。
 */
export function encodeContractCancelledGuidance(
  refs: readonly ContractCancelledGuidanceRef[],
): Readonly<Record<string, string>> {
  if (refs.length === 0) {
    throw new Error('encodeContractCancelledGuidance: refs must be non-empty');
  }
  const wireRefs = refs.map(ref => {
    if (!isGuidanceId(ref.clawId)) {
      throw new Error('encodeContractCancelledGuidance: claw_id must match owner safe ID charset');
    }
    if (!isGuidanceId(ref.contractId)) {
      throw new Error('encodeContractCancelledGuidance: contract_id must match owner safe ID charset');
    }
    return { claw_id: ref.clawId, contract_id: ref.contractId };
  });
  return {
    [WIRE_KEYS.version]: CONTRACT_CANCELLED_GUIDANCE_SCHEMA_VERSION,
    [WIRE_KEYS.cancelledRefs]: JSON.stringify(wireRefs),
  };
}

function fail(field: string, detail: string): never {
  throw new ContractCancelledGuidanceDecodeError('schema_invalid', detail, field);
}

function decodeId(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    fail(field, 'expected non-empty string id');
  }
  if (!isGuidanceId(raw)) {
    fail(field, 'id does not match owner safe ID charset');
  }
  return raw;
}

/** legacy entry 必须携带 non-empty reason（两个 production writer 的真实 shape；不跨给 typed state）。 */
function decodeLegacyReason(raw: unknown, field: string): void {
  if (typeof raw !== 'string' || raw.length === 0) {
    fail(field, 'expected non-empty string reason');
  }
}

/**
 * JSON array → fresh typed refs。逐项新建、不把 parsed array 直接 cast/filter；
 * 空 array 或任一坏项整条 throw（v1 与 legacy batch 共用同一 non-empty invariant）。
 */
function decodeRefsArray(parsed: unknown, field: string, requireLegacyReason: boolean): ContractCancelledGuidanceRef[] {
  if (!Array.isArray(parsed)) {
    fail(field, 'refs must be a JSON array');
  }
  if (parsed.length === 0) {
    fail(field, 'refs must be non-empty');
  }
  const refs: ContractCancelledGuidanceRef[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(field, 'refs item must be a plain object');
    }
    const record = item as Record<string, unknown>;
    const clawField = requireLegacyReason ? LEGACY_KEYS.sourceClaw : 'claw_id';
    refs.push({
      clawId: makeClawId(decodeId(record[clawField], clawField)),
      contractId: makeContractId(decodeId(record.contract_id, 'contract_id')),
    });
    if (requireLegacyReason) {
      decodeLegacyReason(record.reason, LEGACY_KEYS.reason);
    }
  }
  return refs;
}

/** v1 `cancelled_contract_refs` JSON → fresh typed refs（non-empty）。 */
function decodeV1Refs(raw: string): ContractCancelledGuidanceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContractCancelledGuidanceDecodeError('schema_invalid', 'cancelled_contract_refs is not valid JSON', WIRE_KEYS.cancelledRefs);
  }
  return decodeRefsArray(parsed, WIRE_KEYS.cancelledRefs, false);
}

/** legacy batch `cancellations` JSON → fresh typed refs（non-empty；逐 entry 验证 reason）。 */
function decodeLegacyCancellations(raw: string): ContractCancelledGuidanceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContractCancelledGuidanceDecodeError('schema_invalid', 'cancellations is not valid JSON', LEGACY_KEYS.cancellations);
  }
  return decodeRefsArray(parsed, LEGACY_KEYS.cancellations, true);
}

/**
 * consumer 侧 decode：wire envelope → typed state。
 *
 * - version `'1'`：required `cancelled_contract_refs` JSON non-empty array；不得同时
 *   携带任一 legacy dialect key（mixed dialect = ambiguous，schema_invalid）；
 * - version 缺失 + `cancellations` key 存在（存在性识别、不用 truthy）：legacy batch，
 *   JSON 必须 non-empty array，每项必须有合法 `source_claw` / `contract_id` 与
 *   non-empty string `reason`；任一坏 entry 整条 throw、禁止部分过滤；
 * - version 缺失且无 `cancellations`：legacy single，`source_claw`、`contract_id`、
 *   `reason` 三字段全部 required 且合法（reason 必须 non-empty string）；
 * - `cancellations` 与任一 single key 并存：ambiguous legacy，schema_invalid；
 * - 其他 version：`unknown_schema_version`；
 * - `type !== 'contract_cancelled'`、`from !== 'system'`（owner provenance）、坏 JSON、
 *   空/非 array、非 object item、缺字段、非法 ID：schema_invalid；
 * - 额外 generic metadata key 不拒绝，但不能替代 required owner 字段；
 * - reason 只用于验证 legacy shape 完整，不进入 typed state（M#8：不跨边界重复）。
 */
export function decodeContractCancelledGuidance(
  input: ContractCancelledGuidanceWire,
): ContractCancelledGuidanceState {
  if (input.type !== WIRE_TYPE) {
    throw new ContractCancelledGuidanceDecodeError('schema_invalid', `unexpected type=${input.type}`);
  }
  if (input.from !== WIRE_FROM) {
    throw new ContractCancelledGuidanceDecodeError('schema_invalid', 'unexpected source (envelope from)', 'from');
  }

  const meta = input.meta ?? {};
  const version = meta[WIRE_KEYS.version];
  if (version !== undefined && version !== CONTRACT_CANCELLED_GUIDANCE_SCHEMA_VERSION) {
    throw new ContractCancelledGuidanceDecodeError(
      'unknown_schema_version',
      `version=${version}`,
      WIRE_KEYS.version,
    );
  }

  const hasCancellations = LEGACY_KEYS.cancellations in meta;
  const hasSingleKeys =
    LEGACY_KEYS.sourceClaw in meta || LEGACY_KEYS.contractId in meta || LEGACY_KEYS.reason in meta;
  if (hasCancellations && hasSingleKeys) {
    fail(LEGACY_KEYS.cancellations, 'ambiguous legacy dialect: single keys and cancellations both present');
  }

  if (version === CONTRACT_CANCELLED_GUIDANCE_SCHEMA_VERSION) {
    if (hasCancellations || hasSingleKeys) {
      fail(WIRE_KEYS.cancelledRefs, 'mixed dialect: v1 wire must not carry legacy keys');
    }
    const raw = meta[WIRE_KEYS.cancelledRefs];
    if (raw === undefined) {
      fail(WIRE_KEYS.cancelledRefs, 'missing required field');
    }
    return { schemaVersion: 1, contractRefs: decodeV1Refs(raw) };
  }

  // legacy（缺 version）两类真实 production shape
  if (hasCancellations) {
    return { schemaVersion: 1, contractRefs: decodeLegacyCancellations(meta[LEGACY_KEYS.cancellations]) };
  }
  const sourceClaw = meta[LEGACY_KEYS.sourceClaw];
  const contractId = meta[LEGACY_KEYS.contractId];
  const reason = meta[LEGACY_KEYS.reason];
  if (sourceClaw === undefined || contractId === undefined || reason === undefined) {
    fail(
      sourceClaw === undefined
        ? LEGACY_KEYS.sourceClaw
        : contractId === undefined
          ? LEGACY_KEYS.contractId
          : LEGACY_KEYS.reason,
      'legacy single requires source_claw, contract_id and reason',
    );
  }
  decodeLegacyReason(reason, LEGACY_KEYS.reason);
  return {
    schemaVersion: 1,
    contractRefs: [{
      clawId: makeClawId(decodeId(sourceClaw, LEGACY_KEYS.sourceClaw)),
      contractId: makeContractId(decodeId(contractId, LEGACY_KEYS.contractId)),
    }],
  };
}
