/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 1259 Step A: ClawTopology-owned `claw_outbox_summary` guidance codec.
 *
 * 业主 (core/claw-topology/jobs/outbox-summary) 独占 cross-claw unread 汇总事实与
 * 其持久化 wire schema：
 * - producer (write.writeNewSummary) 只经 {@link encodeOutboxSummaryGuidance} 产生
 *   `extraFields`，不再把 scan state 六字段手工平铺 + writer 再补
 *   `summary-hash`（hash 双源 / 无 version / 无派生一致性验证，M#7/M#8）；
 * - consumer (assembly guidance composer) 只经 {@link decodeOutboxSummaryGuidance}
 *   读取 typed state，不再 `Number(total_msgs)` + 静默 fallback。
 *
 * v1 wire 只保留真正用于恢复、dedup 与 guidance 的最小事实（5 字段）：
 * `guidance_schema_version` / `summary-hash` / `counts` / `total_claws` / `total_msgs`。
 * 旧 `hash`（与 `summary-hash` 恒同值的重复事实）、`failed_claws` / `incomplete`
 * （writer 前 fail-closed 后恒 `[]`/`false`）不再写入；legacy decoder 仍验证这些
 * 旧字段，损坏历史状态不会被伪装成合法 v1。
 *
 * M#4: inbox 可跨重启恢复 → 显式 schema version + legacy read + unknown-version
 * failure 都是协议的一部分。当前 writer 总写 v1；decoder 同时接受 v1 与「缺
 * version 的现存 legacy production shape」，拒绝未知版本。
 *
 * 本文件保持纯函数、零 runtime resource/import，供 Assembly composer 以
 * protocol-only 方式 import（同 watchdog/claw-inactivity-guidance.ts 模式）。
 */

import { makeClawId } from '../../../../foundation/claw-identity/index.js';
import type { ClawId } from '../../../../foundation/claw-identity/index.js';
import { SUMMARY_HASH_META_KEY } from './dedup.js';
import { HASH_LEN } from './hash.js';
import type { OutboxSummaryState } from './types.js';

/** 当前 writer 持久化的 schema version（string wire value）。 */
export const OUTBOX_SUMMARY_GUIDANCE_SCHEMA_VERSION = '1' as const;

/** owner-local wire key（metadata key，仅此文件声明；`summary-hash` owner 是 dedup.ts）。 */
const WIRE_KEYS = {
  version: 'guidance_schema_version',
  summaryHash: SUMMARY_HASH_META_KEY,
  counts: 'counts',
  totalClaws: 'total_claws',
  totalMsgs: 'total_msgs',
} as const;

/** legacy（缺 version）production shape 独有的旧字段。 */
const LEGACY_KEYS = {
  hash: 'hash',
  failedClaws: 'failed_claws',
  incomplete: 'incomplete',
} as const;

/**
 * wire envelope type 字面（producer 侧 owner 是 write.ts `SUMMARY_INBOX_TYPE`，
 * 两值必须一致；decoder 据此拒绝非本 type 的 envelope）。
 */
const WIRE_TYPE = 'claw_outbox_summary';

/** sender 唯一：writer 固定 `from='system'`（owner provenance）。 */
const WIRE_FROM = 'system';

/** decoder 产出的 typed state（consumer 唯一依赖的稳定形状）。 */
export interface OutboxSummaryGuidanceState {
  readonly schemaVersion: 1;
  /** canonical dedup hash（wire `summary-hash`；12 位 hex）。 */
  readonly hash: string;
  readonly counts: Readonly<Record<ClawId, number>>;
  /** == Object.keys(counts).length，> 0。 */
  readonly totalClaws: number;
  /** == sum(counts values)，> 0。 */
  readonly totalMsgs: number;
}

/**
 * decoder 最小结构化入参 — 本地声明、禁止 import Assembly。
 * 与 Runtime `GuidanceEnvelope { type, from, meta }` structural 兼容。
 */
export interface OutboxSummaryGuidanceWire {
  readonly type: string;
  readonly from: string;
  readonly meta: Readonly<Record<string, string>>;
}

type OutboxSummaryGuidanceDecodeErrorReason =
  | 'unknown_schema_version'
  | 'schema_invalid';

/**
 * malformed/unknown wire 的 typed error。
 * message 只含 type/version/field/reason，不回显 counts JSON 或 body。
 */
export class OutboxSummaryGuidanceDecodeError extends Error {
  readonly reason: OutboxSummaryGuidanceDecodeErrorReason;
  readonly field: string | undefined;

  constructor(
    reason: OutboxSummaryGuidanceDecodeErrorReason,
    detail: string,
    field?: string,
  ) {
    super(`claw_outbox_summary guidance decode failed: reason=${reason}${field ? ` field=${field}` : ''} ${detail}`);
    this.name = 'OutboxSummaryGuidanceDecodeError';
    this.reason = reason;
    this.field = field;
  }
}

function isOwnerHashFormat(value: string): boolean {
  return value.length === HASH_LEN && /^[0-9a-f]+$/.test(value);
}

/**
 * producer 侧 encode：scan state → wire `extraFields`（总写 v1 精确五字段）。
 *
 * 写盘前验证 writer 前置不变量（tick fail-closed 保证，但 encoder 不依赖调用序）：
 * incomplete=false / failed_claws=[] / totals>0 且与 counts 派生一致 /
 * 每个 count 正 safe integer / hash 符合 owner hash format。
 */
export function encodeOutboxSummaryGuidance(
  state: OutboxSummaryState,
): Readonly<Record<string, string>> {
  if (state.incomplete !== false) {
    throw new Error('encodeOutboxSummaryGuidance: incomplete state must not be persisted');
  }
  if (state.failed_claws.length !== 0) {
    throw new Error('encodeOutboxSummaryGuidance: failed_claws must be empty');
  }
  if (!isOwnerHashFormat(state.hash)) {
    throw new Error('encodeOutboxSummaryGuidance: hash must match owner hash format');
  }
  const countEntries = Object.entries(state.counts);
  let sum = 0;
  for (const [, value] of countEntries) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('encodeOutboxSummaryGuidance: every count must be a positive safe integer');
    }
    sum += value;
  }
  if (!Number.isSafeInteger(state.total_claws) || state.total_claws <= 0 || state.total_claws !== countEntries.length) {
    throw new Error('encodeOutboxSummaryGuidance: total_claws must be > 0 and equal counts key count');
  }
  if (!Number.isSafeInteger(state.total_msgs) || state.total_msgs <= 0 || state.total_msgs !== sum) {
    throw new Error('encodeOutboxSummaryGuidance: total_msgs must be > 0 and equal counts sum');
  }
  return {
    [WIRE_KEYS.version]: OUTBOX_SUMMARY_GUIDANCE_SCHEMA_VERSION,
    [WIRE_KEYS.summaryHash]: state.hash,
    [WIRE_KEYS.counts]: JSON.stringify(state.counts),
    [WIRE_KEYS.totalClaws]: String(state.total_claws),
    [WIRE_KEYS.totalMsgs]: String(state.total_msgs),
  };
}

function requireField(
  meta: Readonly<Record<string, string>>,
  field: string,
): string {
  const value = meta[field];
  if (value === undefined || value.length === 0) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'missing or empty required field', field);
  }
  return value;
}

function decodeHash(raw: string, field: string): string {
  if (!isOwnerHashFormat(raw)) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'expected owner hash format', field);
  }
  return raw;
}

function decodePositiveInt(raw: string, field: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'expected positive integer string', field);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'expected positive safe integer', field);
  }
  return value;
}

/**
 * counts JSON → fresh typed record。显式遍历 own entries、逐 key 经 makeClawId
 * 恢复 brand、构造 fresh object，不把 untrusted parsed object 直接品牌化。
 */
function decodeCounts(raw: string): Readonly<Record<ClawId, number>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'counts is not valid JSON', WIRE_KEYS.counts);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'counts must be a plain object', WIRE_KEYS.counts);
  }
  const fresh: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '__proto__') {
      throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'counts key rejected', WIRE_KEYS.counts);
    }
    let clawId: ClawId;
    try {
      clawId = makeClawId(key);
    } catch {
      throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'counts key is not a valid claw id', WIRE_KEYS.counts);
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'counts value must be a positive safe integer', WIRE_KEYS.counts);
    }
    fresh[clawId] = value;
  }
  return fresh;
}

/**
 * consumer 侧 decode：wire envelope → typed state。
 *
 * - version `'1'`：严格校验 v1 五字段；
 * - version 缺失：按 legacy production shape 解析（旧字段全部 required），并额外
 *   验证 `hash === summary-hash`、`failed_claws` deep-equals `[]`、`incomplete === 'false'`，
 *   通过后返回 `schemaVersion: 1`；
 * - 其他 version：`unknown_schema_version`；
 * - `type !== 'claw_outbox_summary'`、`from !== 'system'`（owner provenance）、
 *   hash 格式错、counts 非 plain object / key 非法 claw id / value 非正 safe integer、
 *   totals 非正 safe integer 或与 counts 派生不一致：`schema_invalid`；
 * - 额外 metadata key 不拒绝（owner 不预设 transport generic 扩展字段）。
 */
export function decodeOutboxSummaryGuidance(
  input: OutboxSummaryGuidanceWire,
): OutboxSummaryGuidanceState {
  if (input.type !== WIRE_TYPE) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', `unexpected type=${input.type}`);
  }
  if (input.from !== WIRE_FROM) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'unexpected source (envelope from)', 'from');
  }

  const meta = input.meta ?? {};
  const version = meta[WIRE_KEYS.version];
  if (version !== undefined && version !== OUTBOX_SUMMARY_GUIDANCE_SCHEMA_VERSION) {
    throw new OutboxSummaryGuidanceDecodeError(
      'unknown_schema_version',
      `version=${version}`,
      WIRE_KEYS.version,
    );
  }
  const isLegacy = version === undefined;

  const hash = decodeHash(requireField(meta, WIRE_KEYS.summaryHash), WIRE_KEYS.summaryHash);
  const counts = decodeCounts(requireField(meta, WIRE_KEYS.counts));
  const totalClaws = decodePositiveInt(requireField(meta, WIRE_KEYS.totalClaws), WIRE_KEYS.totalClaws);
  const totalMsgs = decodePositiveInt(requireField(meta, WIRE_KEYS.totalMsgs), WIRE_KEYS.totalMsgs);

  if (isLegacy) {
    // legacy production shape：旧字段全部 required，且不得与 canonical 事实冲突。
    const legacyHash = decodeHash(requireField(meta, LEGACY_KEYS.hash), LEGACY_KEYS.hash);
    if (legacyHash !== hash) {
      throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'legacy hash conflicts with summary-hash', LEGACY_KEYS.hash);
    }
    const failedClawsRaw = requireField(meta, LEGACY_KEYS.failedClaws);
    let failedClaws: unknown;
    try {
      failedClaws = JSON.parse(failedClawsRaw);
    } catch {
      throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'failed_claws is not valid JSON', LEGACY_KEYS.failedClaws);
    }
    if (!Array.isArray(failedClaws) || failedClaws.length !== 0) {
      throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'legacy failed_claws must be []', LEGACY_KEYS.failedClaws);
    }
    const incompleteRaw = requireField(meta, LEGACY_KEYS.incomplete);
    if (incompleteRaw !== 'false') {
      throw new OutboxSummaryGuidanceDecodeError('schema_invalid', `legacy incomplete must be 'false'`, LEGACY_KEYS.incomplete);
    }
  }

  const countValues = Object.values(counts);
  if (totalClaws !== countValues.length) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'total_claws inconsistent with counts', WIRE_KEYS.totalClaws);
  }
  let sum = 0;
  for (const value of countValues) sum += value;
  if (totalMsgs !== sum) {
    throw new OutboxSummaryGuidanceDecodeError('schema_invalid', 'total_msgs inconsistent with counts', WIRE_KEYS.totalMsgs);
  }

  return {
    schemaVersion: 1,
    hash,
    counts,
    totalClaws,
    totalMsgs,
  };
}
