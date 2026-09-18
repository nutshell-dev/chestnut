import type { ClawId } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

/**
 * phase 1864 Step I（CT-D12）：最小事件 sink——Topology 只消费 `write` 形状。
 *
 * 语义（显式立定，不再隐式）：
 * - optional：无观察场景（测试 / 无 audit 装配）可省；resolve/read 主结果不因此变化
 *   （不因观察缺失改变拓扑结果）。
 * - write throw：**传播**——Topology 不 own 观察失败处置、不吞没；写入失败时
 *   caller 得到与 sink owner 一致的失败，与 phase 944 起现状语义一致。
 */
export interface TopologyEventSink {
  write(event: string, ...cols: (string | number)[]): void;
}

/**
 * claw 物理位置 discriminated union。
 *
 * phase 1864 Step E（CT-D8）：remote 伪能力删除——单机实现只有 local 成员；
 * `kind` 判别保留为未来（真正实现分布式时）的扩展缝，不留占位分支。
 */
export type Location = { kind: 'local'; clawDir: string };

export interface ClawTopologyDeps {
  fs: FileSystem;
  chestnutRoot: string;
  /** phase 1864 Step I（CT-D12）：最小 sink（不再依赖完整 AuditLog 面）。 */
  sink?: TopologyEventSink;
  /** phase 520: motionClawId DI 删除、topology 直 import MOTION_CLAW_ID 自家 const */
  motionDir: string;
}

/**
 * phase 1864 Step F（CT-D9）：枚举快照——valid 与 invalid 事实并列。
 *
 * 非法/损坏目录不再只进 audit 后静默丢弃：snapshot.invalid 携带目录名与原因，
 * caller 可把部分列表与完整拓扑区分开（design §2 不变量）。
 */
export interface ClawEnumerationSnapshot {
  /** 有效 claw identity（motion 恒在首位；不含 claws/ 下重复的 motion 目录）。 */
  readonly valid: readonly ClawId[];
  /** 未通过 identity 校验的 claws/ 目录项（不静默丢弃）。 */
  readonly invalid: readonly { readonly dir: string; readonly reason: string }[];
}

export interface ClawTopology {
  /** 列所有 claws（含 motion）；= enumerateSnapshot().valid */
  enumerate(): ClawId[];
  /** phase 1864 Step F（CT-D9）：完整枚举快照（valid + invalid）。 */
  enumerateSnapshot(): ClawEnumerationSnapshot;
  /** claw_id → 物理位置抽象 */
  resolve(clawId: ClawId): Location;
  /** 跨 claw 读文本 */
  read(clawId: ClawId, relPath: string): Promise<string>;
  /**
   * 跨 claw 读 JSON。phase 1811 Step B（CT-D7）：返回 `unknown`——Topology 只
   * 负责读取，不以泛型承诺未经验证的业务类型；schema 验证由资源业务 owner
   * 在 caller 边界显式 decode（禁止 cast 伪验证）。
   */
  readJSON(clawId: ClawId, relPath: string): Promise<unknown>;
}

export class ClawIdResolveError extends Error {
  constructor(public readonly clawId: ClawId, public readonly reason: string) {
    super(`claw "${clawId}" resolve failed: ${reason}`);
    this.name = 'ClawIdResolveError';
  }
}

export class CrossClawReadError extends Error {
  constructor(public readonly clawId: ClawId, public readonly relPath: string, public readonly cause: unknown) {
    super(`cross-claw read failed: claw="${clawId}" relPath="${relPath}": ${String(cause)}`);
    this.name = 'CrossClawReadError';
  }
}
