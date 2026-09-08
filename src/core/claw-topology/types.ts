import type { ClawId } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';

/** claw 物理位置 discriminated union（单机 = local、未来分布式 = remote） */
export type Location =
  | { kind: 'local'; clawDir: string }
  | { kind: 'remote'; endpoint: string }; // 占位、future distributed phase

export interface ClawTopologyDeps {
  fs: FileSystem;
  chestnutRoot: string;
  audit?: AuditLog;
  /** phase 520: motionClawId DI 删除、topology 直 import MOTION_CLAW_ID 自家 const */
  motionDir: string;
}

export interface ClawTopology {
  /** 列所有 claws（含 motion） */
  enumerate(): ClawId[];
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
