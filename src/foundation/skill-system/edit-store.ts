/**
 * Phase 1919 Step C: 技能分支编辑事务记录存储（L2c.SkillSystem）。
 *
 * 每个编辑事务一条 JSON 记录（`edits/<editId>.json`，原子写）。editId 由
 * requestId 确定性派生——同 requestId 重放无需索引即可定位首次记录。
 * 记录是业务侧唯一事务事实来源；发布结果权威仍在 Snapshot 操作记录
 * （稳定 publishOperationId），saved 未决状态经 inspectOperation 对账重建，
 * 两套存储不形成两套发布权威。
 *
 * 本模块只负责持久化/校验/列举，不理解 git 与发布语义（编排在 version-service）。
 */

import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import { sha256ShortHex } from '../node-utils/index.js';
import { SkillVersionError, type SkillEditStatus } from './version-types.js';

const EDITS_DIR = 'edits';

/** 事务记录目录（stateDir 相对路径）；服务启动时确保存在 */
export const SKILL_EDITS_DIR = EDITS_DIR;

/** Phase 1923 Step C：补依据持久记录（依据准入被拒后原地补充；旧失败尝试可追溯） */
export interface SkillBasisAmendment {
  /** 补充幂等键（重放定位首次补充事实） */
  requestId: string;
  /** 新依据序列化原文（重放逐字比较） */
  metadata: string;
  /** 新发布幂等键（与旧失败尝试区分，避免 Snapshot 幂等键输入漂移） */
  publishOperationId: string;
  at: string;
}

/** 编辑事务记录（磁盘形态）。字段语义见 version-types.ts SkillEditInfo。 */
export interface SkillEditRecord {
  schema: 1;
  editId: string;
  requestId: string;
  skillName: string;
  /** 仓库身份：所属版本库根绝对路径（防误读其他库/其他装配的记录） */
  repositoryDir: string;
  /** basis 序列化原文（重放逐字比较，不只比 hash；JSON.parse 还原 SkillBasis） */
  metadata: string;
  /** 编辑基准（begin 时刻整库 published 版本身份） */
  base: string;
  /** 基准时刻技能路径版本（null = 新建技能，absent 基准） */
  basePathRevision: string | null;
  /** 分支工作区 id（preparing 中断窗口可为 null，重放续作补全） */
  workspaceId: string | null;
  /** 保存候选版本身份（未保存为 null；保存后长期可达，含 cancelled） */
  candidate: string | null;
  status: SkillEditStatus;
  parentEditId: string | null;
  /** 稳定发布幂等键（首次 submit 派生后持久在场；busy 待重试凭它续作/对账） */
  publishOperationId: string | null;
  /** published：发布版本身份 */
  version: string | null;
  /** conflict：当前 published 版本身份 */
  current: string | null;
  /** Phase 1923 Step C：补依据链（追加式；旧记录无此字段 = 从未补充）。可选字段——
   *  旧版二进制读新记录时整对象回写不丢字段，schema 保持 1 双向兼容 */
  amendments?: SkillBasisAmendment[];
  createdAt: string;
  updatedAt: string;
}

/** editId 由 requestId 确定性派生：同 requestId 重放定位同一事务记录。 */
export function skillEditId(requestId: string): string {
  return `edit-${sha256ShortHex(`skill-edit:${requestId}`, 24)}`;
}

const STATUS_VALUES: readonly SkillEditStatus[] = [
  'preparing', 'editing', 'saved', 'published', 'conflict', 'cancelled',
];

function assertAmendmentsShape(amendments: SkillBasisAmendment[] | undefined, pathHint: string): void {
  if (amendments === undefined) return;
  const valid = Array.isArray(amendments) && amendments.every(
    a => a !== null && typeof a === 'object' &&
      typeof a.requestId === 'string' && typeof a.metadata === 'string' &&
      typeof a.publishOperationId === 'string' && typeof a.at === 'string',
  );
  if (!valid) {
    throw new SkillVersionError('store_error', `corrupt skill edit record amendments: ${pathHint}`);
  }
}

function assertRecordShape(r: SkillEditRecord, pathHint: string): void {
  const strOrNull = (v: unknown) => v === null || typeof v === 'string';
  if (
    r === null || typeof r !== 'object' || r.schema !== 1 ||
    typeof r.editId !== 'string' || typeof r.requestId !== 'string' ||
    typeof r.skillName !== 'string' || typeof r.repositoryDir !== 'string' ||
    typeof r.metadata !== 'string' || typeof r.base !== 'string' ||
    !strOrNull(r.basePathRevision) || !strOrNull(r.workspaceId) ||
    !strOrNull(r.candidate) || !strOrNull(r.parentEditId) ||
    !strOrNull(r.publishOperationId) || !strOrNull(r.version) || !strOrNull(r.current) ||
    !STATUS_VALUES.includes(r.status) ||
    typeof r.createdAt !== 'string' || typeof r.updatedAt !== 'string'
  ) {
    throw new SkillVersionError('store_error', `corrupt skill edit record: ${pathHint}`);
  }
  assertAmendmentsShape(r.amendments, pathHint);
}

export interface SkillEditStore {
  /** 缺席返回 null；损坏 loud store_error（不伪造事实） */
  load(editId: string): Promise<SkillEditRecord | null>;
  /** 原子写整记录（每次状态迁移即落盘，中断不依赖内存句柄） */
  save(record: SkillEditRecord): Promise<void>;
  /** 全部记录（按 createdAt 升序；损坏记录 loud store_error） */
  list(): Promise<SkillEditRecord[]>;
}

export function createSkillEditStore(stateFs: FileSystem, repositoryDir: string): SkillEditStore {
  const recordPath = (editId: string) => `${EDITS_DIR}/${editId}.json`;

  async function load(editId: string): Promise<SkillEditRecord | null> {
    let raw: string;
    try {
      raw = await stateFs.read(recordPath(editId));
    } catch (e) {
      if (isFileNotFound(e)) return null;
      throw e;
    }
    const r = JSON.parse(raw) as SkillEditRecord;
    assertRecordShape(r, recordPath(editId));
    if (r.repositoryDir !== repositoryDir) {
      // 记录归属其他版本库根：拒绝判读，不把别库事实当本库事实
      throw new SkillVersionError(
        'store_error',
        `skill edit record belongs to a different repository: ${recordPath(editId)} (record=${r.repositoryDir}, expected=${repositoryDir})`,
      );
    }
    return r;
  }

  return {
    load,
    async save(record: SkillEditRecord): Promise<void> {
      assertRecordShape(record, recordPath(record.editId));
      await stateFs.writeAtomic(recordPath(record.editId), JSON.stringify(record, null, 2));
    },
    async list(): Promise<SkillEditRecord[]> {
      await stateFs.ensureDir(EDITS_DIR);
      const entries = await stateFs.list(EDITS_DIR);
      const records: SkillEditRecord[] = [];
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
        const record = await load(entry.name.slice(0, -'.json'.length));
        if (record !== null) records.push(record);
      }
      records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return records;
    },
  };
}
