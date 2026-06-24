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
  /** 跨 claw 读 JSON */
  readJSON<T>(clawId: ClawId, relPath: string): Promise<T>;
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

export class BroadcastNotMotionError extends Error {
  constructor(public readonly callerClawId: ClawId, public readonly tool: string) {
    super(`broadcast "*" is Motion-only (per DP11). caller="${callerClawId}", tool="${tool}"`);
    this.name = 'BroadcastNotMotionError';
  }
}
