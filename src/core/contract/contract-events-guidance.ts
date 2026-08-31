/**
 * @module L4.ContractSystem
 * phase 1261 Step A: ContractSystem-owned `contract_events` guidance codec.
 *
 * 业主 (core/contract) 独占 contract events guidance 事实与其持久化 wire schema：
 * - producer（Assembly contract-notification-adapter 的 single path 与
 *   contract-observer cron 的 batch path）只经 {@link encodeContractEventsGuidance}
 *   产生 `extraFields`，不再手写 `source_claw` / `contract_id` / `problem_pairs` 两套
 *   无版本 legacy dialect；
 * - consumer（Assembly guidance composer）只经 {@link decodeContractEventsGuidance}
 *   读取 typed refs，不再自行拆 CSV / 校验 ID / 逐项静默过滤 malformed pair。
 *
 * v1 wire 精确两字段：
 *   guidance_schema_version: "1"
 *   contract_refs: '[{"claw_id":"worker-1","contract_id":"1780-abcd"}]'
 * `contract_refs` 是 canonical JSON array，空数组合法（observer 正文覆盖全部
 * completed events、只为 hasFailure 契约生成 CLI 调查入口，空 refs 是现存业务事实）。
 *
 * M#4: inbox 可跨重启恢复 → 显式 schema version + legacy read + unknown-version
 * failure 都是协议的一部分。当前 writer 总写 v1；decoder 同时读取两类缺 version 的
 * 真实 legacy production shape（adapter single / observer CSV batch），拒绝未知版本。
 * legacy CSV 任一 malformed pair 整条 typed throw（不再部分过滤：部分过滤静默丢
 * 磁盘事实且无法从日志重建被忽略项；Runtime 保证正文继续交付并 audit guidance 失败）。
 *
 * ID 约束沿用现存 wire 防注入规则 `^[A-Za-z0-9_-]{1,64}$`（phase 324 H11）：
 * brand 只表达 owner 类型、不验证外部/历史磁盘值，故 encode/decode boundary 各自校验。
 *
 * 本文件保持纯函数、零 runtime resource/import，供 Assembly composer 以
 * protocol-only 方式 import（同 watchdog/claw-inactivity-guidance.ts 模式）。
 */

import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { makeContractId } from './types.js';
import type { ContractId } from './types.js';

/** 当前 writer 持久化的 schema version（string wire value）。 */
const CONTRACT_EVENTS_GUIDANCE_SCHEMA_VERSION = '1' as const;

/** owner-local wire key（metadata key，仅此文件声明）。 */
const WIRE_KEYS = {
  version: 'guidance_schema_version',
  contractRefs: 'contract_refs',
} as const;

/** legacy（缺 version）production shape 的两套 dialect key。 */
const LEGACY_KEYS = {
  sourceClaw: 'source_claw',
  contractId: 'contract_id',
  problemPairs: 'problem_pairs',
} as const;

/** wire envelope type 字面（两条 production path 共用；decoder 据此拒绝非本 type）。 */
const WIRE_TYPE = 'contract_events';

/** sender 唯一：两条 production path 均 `from='system'`（owner provenance）。 */
const WIRE_FROM = 'system';

/** 单条 contract event guidance reference（typed owner fact）。 */
export interface ContractEventGuidanceRef {
  readonly clawId: ClawId;
  readonly contractId: ContractId;
}

/** decoder 产出的 typed state（consumer 唯一依赖的稳定形状）。 */
interface ContractEventsGuidanceState {
  readonly schemaVersion: 1;
  readonly contractRefs: readonly ContractEventGuidanceRef[];
}

/**
 * decoder 最小结构化入参 — 本地声明、禁止 import Assembly。
 * 与 Runtime `GuidanceEnvelope { type, from, meta }` structural 兼容。
 */
export interface ContractEventsGuidanceWire {
  readonly type: string;
  readonly from: string;
  readonly meta: Readonly<Record<string, string>>;
}

type ContractEventsGuidanceDecodeErrorReason =
  | 'unknown_schema_version'
  | 'schema_invalid';

/**
 * malformed/unknown wire 的 typed error。
 * message 只含 type/version/field/reason，不回显 metadata 或 `contract_refs` 内容。
 */
export class ContractEventsGuidanceDecodeError extends Error {
  readonly reason: ContractEventsGuidanceDecodeErrorReason;
  readonly field: string | undefined;

  constructor(
    reason: ContractEventsGuidanceDecodeErrorReason,
    detail: string,
    field?: string,
  ) {
    super(`contract_events guidance decode failed: reason=${reason}${field ? ` field=${field}` : ''} ${detail}`);
    this.name = 'ContractEventsGuidanceDecodeError';
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
 * 空 refs 合法；逐项执行 safe ID 校验；wire 只含 owner 两 key、不持有输入引用。
 */
export function encodeContractEventsGuidance(
  refs: readonly ContractEventGuidanceRef[],
): Readonly<Record<string, string>> {
  const wireRefs = refs.map(ref => {
    if (!isGuidanceId(ref.clawId)) {
      throw new Error('encodeContractEventsGuidance: claw_id must match owner safe ID charset');
    }
    if (!isGuidanceId(ref.contractId)) {
      throw new Error('encodeContractEventsGuidance: contract_id must match owner safe ID charset');
    }
    return { claw_id: ref.clawId, contract_id: ref.contractId };
  });
  return {
    [WIRE_KEYS.version]: CONTRACT_EVENTS_GUIDANCE_SCHEMA_VERSION,
    [WIRE_KEYS.contractRefs]: JSON.stringify(wireRefs),
  };
}

function fail(field: string, detail: string): never {
  throw new ContractEventsGuidanceDecodeError('schema_invalid', detail, field);
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

/** v1 `contract_refs` JSON → fresh typed refs。逐项新建、不把 parsed array 直接 cast。 */
function decodeV1Refs(raw: string): ContractEventGuidanceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContractEventsGuidanceDecodeError('schema_invalid', 'contract_refs is not valid JSON', WIRE_KEYS.contractRefs);
  }
  if (!Array.isArray(parsed)) {
    fail(WIRE_KEYS.contractRefs, 'contract_refs must be a JSON array');
  }
  const refs: ContractEventGuidanceRef[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(WIRE_KEYS.contractRefs, 'contract_refs item must be a plain object');
    }
    const record = item as Record<string, unknown>;
    refs.push({
      clawId: makeClawId(decodeId(record.claw_id, 'claw_id')),
      contractId: makeContractId(decodeId(record.contract_id, 'contract_id')),
    });
  }
  return refs;
}

/** legacy batch CSV：仅整个 `problem_pairs === ''` 合法返空 refs；非空 CSV 每个 segment 必须恰是 `<claw>:<contract>`，任一坏项（含多余逗号产生的空 segment）整条 throw，禁止部分过滤。 */
function decodeLegacyPairs(raw: string): ContractEventGuidanceRef[] {
  if (raw.length === 0) return [];
  const refs: ContractEventGuidanceRef[] = [];
  for (const segment of raw.split(',')) {
    const pair = segment.trim();
    if (pair.length === 0) {
      fail(LEGACY_KEYS.problemPairs, 'legacy pair segment must not be empty (stray comma)');
    }
    const parts = pair.split(':');
    if (parts.length !== 2) {
      fail(LEGACY_KEYS.problemPairs, 'legacy pair must be exactly <claw>:<contract>');
    }
    refs.push({
      clawId: makeClawId(decodeId(parts[0], 'claw_id')),
      contractId: makeContractId(decodeId(parts[1], 'contract_id')),
    });
  }
  return refs;
}

/**
 * consumer 侧 decode：wire envelope → typed state。
 *
 * - version `'1'`：required `contract_refs` JSON array（空数组合法）；不得同时携带
 *   任一 legacy dialect key（mixed dialect = ambiguous，schema_invalid）；
 * - version 缺失 + `problem_pairs` 存在：legacy batch CSV；
 * - version 缺失且无 `problem_pairs`：legacy single，`source_claw` 与 `contract_id`
 *   必须同时存在且合法；
 * - single keys 与 `problem_pairs` 同时出现：ambiguous legacy，schema_invalid；
 * - 其他 version：`unknown_schema_version`；
 * - `type !== 'contract_events'`、`from !== 'system'`（owner provenance）、坏 JSON、
 *   非 array、非 object item、缺字段、非法 ID：schema_invalid；
 * - 额外 generic metadata key 不拒绝，但不能替代 required owner 字段。
 */
export function decodeContractEventsGuidance(
  input: ContractEventsGuidanceWire,
): ContractEventsGuidanceState {
  if (input.type !== WIRE_TYPE) {
    throw new ContractEventsGuidanceDecodeError('schema_invalid', `unexpected type=${input.type}`);
  }
  if (input.from !== WIRE_FROM) {
    throw new ContractEventsGuidanceDecodeError('schema_invalid', 'unexpected source (envelope from)', 'from');
  }

  const meta = input.meta ?? {};
  const version = meta[WIRE_KEYS.version];
  if (version !== undefined && version !== CONTRACT_EVENTS_GUIDANCE_SCHEMA_VERSION) {
    throw new ContractEventsGuidanceDecodeError(
      'unknown_schema_version',
      `version=${version}`,
      WIRE_KEYS.version,
    );
  }

  const hasPairs = LEGACY_KEYS.problemPairs in meta;
  const hasSingleKeys = LEGACY_KEYS.sourceClaw in meta || LEGACY_KEYS.contractId in meta;
  if (hasPairs && hasSingleKeys) {
    fail(LEGACY_KEYS.problemPairs, 'ambiguous legacy dialect: single keys and problem_pairs both present');
  }

  if (version === CONTRACT_EVENTS_GUIDANCE_SCHEMA_VERSION) {
    if (hasPairs || hasSingleKeys) {
      fail(WIRE_KEYS.contractRefs, 'mixed dialect: v1 wire must not carry legacy keys');
    }
    const raw = meta[WIRE_KEYS.contractRefs];
    if (raw === undefined) {
      fail(WIRE_KEYS.contractRefs, 'missing required field');
    }
    return { schemaVersion: 1, contractRefs: decodeV1Refs(raw) };
  }

  // legacy（缺 version）两类真实 production shape
  if (hasPairs) {
    return { schemaVersion: 1, contractRefs: decodeLegacyPairs(meta[LEGACY_KEYS.problemPairs]) };
  }
  const sourceClaw = meta[LEGACY_KEYS.sourceClaw];
  const contractId = meta[LEGACY_KEYS.contractId];
  if (sourceClaw === undefined || contractId === undefined) {
    fail(
      sourceClaw === undefined ? LEGACY_KEYS.sourceClaw : LEGACY_KEYS.contractId,
      'legacy single requires both source_claw and contract_id',
    );
  }
  return {
    schemaVersion: 1,
    contractRefs: [{
      clawId: makeClawId(decodeId(sourceClaw, LEGACY_KEYS.sourceClaw)),
      contractId: makeContractId(decodeId(contractId, LEGACY_KEYS.contractId)),
    }],
  };
}
