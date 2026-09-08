/**
 * @module L4.Permissions
 * Claw permission policy (L4 业务 / phase377 从 L1 迁出 / phase430 彻底归 L4)
 *
 * Enforces access rules:
 * - System space (read-only): AGENTS.md, dialog/, config.yaml, .chestnut/, system/
 * - Claw writable space: MEMORY.md, memory/, USER.md, IDENTITY.md, SOUL.md,
 *   clawspace/, prompts/, skills/, inbox/, outbox/, tasks/queues/{pending,running,done,failed}, logs/
 * - Claw readable space: + contract/, tasks/queues/results/, tasks/sync/subagent/, tasks/sync/spawn/, tasks/sync/shadow/, tasks/subagents/
 * - Outside clawDir: denied (PathNotInClawSpaceError)
 *
 * Phase 1200: cross-claw access is managed by hub-and-spoke topology (motion routes);
 * PermissionChecker is caller-scoped, not target-scoped. Direct claw-to-claw
 * read/write is not enforced here — see foundation/file-tool/read.ts line 103-104.
 *
 * Phase430: claw-scoped permission policy + createClawPermissionChecker 归L4；
 * PermissionChecker capability shape现归ToolProtocol，Permissions只import协议type。
 * NodeFileSystem (L1) 0 PermissionChecker dep / 0 业务概念。
 * L4 caller (FileTool 等) 自治调 claw-permissions check 后 call fs。
 */

import * as path from 'path';
import {
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
} from './errors.js';
import { PathGuardError } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { PERMISSION_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from '../async-task-system/index.js';
import { TASKS_SUBAGENTS_DIR } from '../subagent/index.js';
import { CLAWSPACE_DIR, CLAW_SPEC_FILE, CLAW_MEMORY_FILE, CLAW_IDENTITY_FILE, CLAW_USER_FILE, CLAW_SOUL_FILE } from '../../foundation/claw-identity/index.js';
import { CONFIG_YAML_FILE } from '../claw-topology/index.js';
import { DIALOG_DIR } from '../../foundation/dialog-store/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';


/**
 * System directories/files that are read-only for claws
 */
const SYSTEM_PATHS = [
  CLAW_SPEC_FILE,
  DIALOG_DIR,
  CONFIG_YAML_FILE,
  '.chestnut',
  'system',
];

/**
 * Directories where claws can write（base paths / 不含 taskSyncDirs）
 * Phase 1335: task sync dirs 装配期 inject
 */
const BASE_WRITABLE_PATHS = [
  CLAW_MEMORY_FILE,
  'memory',
  CLAW_USER_FILE,
  CLAW_IDENTITY_FILE,
  CLAW_SOUL_FILE,
  CLAWSPACE_DIR,
  'prompts',
  'skills',
  'inbox',
  'outbox',
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,            // phase 512 / 子代理 workspace
  'logs',
];

/**
 * Phase 1783: 权限 deny / non-strict bypass 事件必须可观察——factory 只要求最小
 * audit write capability（不依赖完整 AuditLog，不引入 CLI/装配语义）。
 */
export type PermissionAuditSink = Pick<AuditLog, 'write'>;

/**
 * phase 1818 (PERMISSIONS-FS-OPTIONAL-DISABLES-CANONICAL-GUARD): canonical 路径判定
 * 是安全不变量——checker 构造期必须接收 owner filesystem 的 canonical resolve capability
 * （NodeFileSystem.resolve = resolveAndCheck：`..` 穿越拒绝 + realpath symlink-escape guard），
 * 不允许退回 path.resolve 词法检查的弱 checker。实际消费仅 sync resolve 单方法，
 * 最小接口冻结为 Pick<FileSystem, 'resolve'>，不把完整 FileSystem 向上暴露。
 */
export type ClawPermissionFs = Pick<FileSystem, 'resolve'>;

interface ClawPermissionOptions {
  /** Base directory for the claw */
  clawDir: string;

  /** System paths that should be read-only (default: SYSTEM_PATHS) */
  systemPaths?: string[];

  /** Whether to enforce strict mode (default: true) */
  strict?: boolean;

  /**
   * Required audit sink for permission events (phase 1783)。
   * deny 与 non-strict bypass 属安全事件，不允许 optional silent path——
   * 缺失 sink 在 createClawPermissionChecker 构造时显式抛错。
   */
  audit: PermissionAuditSink;

  /**
   * Required canonical fs capability for path resolution（phase 1818）。
   * symlink traversal guard 依赖 owner filesystem 的 canonical resolve——
   * 缺失在 createClawPermissionChecker 构造时显式抛错，无 path.resolve 词法 fallback。
   */
  fs: ClawPermissionFs;

  /** Phase 1335: task sync directories injected at assembly time */
  taskSyncDirs?: readonly string[];
}

/**
 * phase 1819 (PERMISSIONS-WRITABLE-HINT-DUPLICATES-POLICY): 当前实例真实 writable policy
 * 的单一来源（静态 base + 装配期注入 taskSyncDirs）。deny hint 与 allow 判定共用此结果，
 * errors.ts 不再手写镜像。
 */
function buildWritablePaths(taskSyncDirs?: readonly string[]): readonly string[] {
  return taskSyncDirs ? [...BASE_WRITABLE_PATHS, ...taskSyncDirs] : BASE_WRITABLE_PATHS;
}

/**
 * Check if relative path matches any of the patterns
 * Matches complete path components only (not substrings)
 */
function matchesPathPatterns(
  relativePath: string,
  patterns: readonly string[]
): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(p => p.length > 0);

  for (const pattern of patterns) {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/\/$/, '');
    const patternParts = normalizedPattern.split('/').filter(p => p.length > 0);

    // Direct match
    if (normalized === normalizedPattern) {
      return true;
    }

    // Is or is within the pattern directory
    // e.g., pattern "dialog" matches "dialog/file.txt"
    if (parts.length >= patternParts.length) {
      const matchParts = parts.slice(0, patternParts.length);
      if (matchParts.join('/') === normalizedPattern) {
        return true;
      }
    }

  }

  return false;
}

/**
 * Get path relative to claw directory
 */
function getRelativeToClaw(
  clawDir: string,
  targetPath: string,
  fs: ClawPermissionFs
): string | null {
  try {
    // phase 324 C3: 始终用 options.clawDir 解析 claw root，不依赖 fs.resolve('.')。
    // 旧代码在 fs 由 chestnut-root-scoped factory 构造时（evolution-system / memory
    // 经 clawFsFactory），claw root 被取作更宽 root → containment 检查放过任意
    // <chestnutRoot>/* → 读隔离失效。
    // phase 1818: fs 为构造期必需 canonical capability，无 path.resolve 词法 fallback。
    const resolvedClaw = fs.resolve(clawDir);
    const resolvedTarget = fs.resolve(targetPath);

    if (
      resolvedTarget === resolvedClaw ||
      resolvedTarget.startsWith(resolvedClaw + path.sep)
    ) {
      return path.relative(resolvedClaw, resolvedTarget);
    }

    return null;
  } catch (err) {
    if (err instanceof PathGuardError) {
      return null; // genuine containment violation
    }
    throw err; // ENOENT, EACCES, EIO, EPERM, EROFS, ELOOP, ENOTDIR, etc. — propagate
  }
}

/**
 * Check read permission for a path
 * @throws PathNotInClawSpaceError if path is outside claw space
 */
function checkReadPermission(
  targetPath: string,
  options: ClawPermissionOptions
): void {
  const { clawDir, strict = true, audit } = options;

  // Non-strict mode allows everything
  if (!strict) {
    // phase 713: raw msg 改 key= prefix、forensic 解析可 join reason 维度
    // phase 1783: audit 必需 sink，非 optional chaining
    audit.write(PERMISSION_AUDIT_EVENTS.STRICT_DISABLED, 'reason=non_strict_mode_bypass');
    return;
  }

  // Check if within clawDir
  const relativePath = getRelativeToClaw(clawDir, targetPath, options.fs);

  if (relativePath !== null) {
    // Within clawDir - readable by default
    return;
  }

  // Denied
  options.audit.write(
    PERMISSION_AUDIT_EVENTS.READ_PATH_OUTSIDE_CLAW_SPACE,
    `path=${targetPath}`,
    `clawDir=${clawDir}`,
  );
  throw new PathNotInClawSpaceError(targetPath, clawDir);
}

/**
 * Check write permission for a path
 * @throws PathNotInClawSpaceError if path is outside claw space
 * @throws WriteOperationForbiddenError if path is system read-only or outside writable allowlist
 */
function checkWritePermission(
  targetPath: string,
  options: ClawPermissionOptions
): void {
  const {
    clawDir,
    systemPaths = SYSTEM_PATHS,
    strict = true,
    audit,
  } = options;

  // Non-strict mode allows everything
  if (!strict) {
    // phase 713: raw msg 改 key= prefix、forensic 解析可 join reason 维度
    // phase 1783: audit 必需 sink，非 optional chaining
    audit.write(PERMISSION_AUDIT_EVENTS.STRICT_DISABLED, 'reason=non_strict_mode_bypass');
    return;
  }

  // Check if within clawDir
  const relativePath = getRelativeToClaw(clawDir, targetPath, options.fs);

  if (relativePath !== null) {
    const writablePaths = buildWritablePaths(options.taskSyncDirs);
    const isSystemPath = matchesPathPatterns(relativePath, systemPaths);
    const isWritablePath = matchesPathPatterns(relativePath, writablePaths);

    // Check system paths (read-only)
    if (isSystemPath) {
      options.audit.write(
        PERMISSION_AUDIT_EVENTS.WRITE_SYSTEM_READONLY,
        `path=${targetPath}`,
      );
      throw new WriteOperationForbiddenError(targetPath, 'system_readonly');
    }

    // Check writable paths
    if (isWritablePath) {
      return;
    }

    // phase 446 (review): fallthrough deny-by-default。
    // 至此 isSystemPath=false（上方 throw 已 cover true）+ isWritablePath=false
    // （上方 return 已 cover true）—— 原 `if (!isSystemPath && !isWritablePath)` 永真、
    // 后跟 unreachable return —— 删冗余条件、直接 throw。
    options.audit.write(
      PERMISSION_AUDIT_EVENTS.WRITE_OUTSIDE_ALLOWLIST,
      `path=${targetPath}`,
    );
    // phase 1819: hint 携带当前实例真实 writablePaths（含动态 taskSyncDirs），
    // 由 owner 注入、errors.ts 只格式化
    throw new WriteOperationForbiddenError(targetPath, 'outside_allowlist', writablePaths);
  }

  // Denied
  options.audit.write(
    PERMISSION_AUDIT_EVENTS.WRITE_PATH_OUTSIDE_CLAW_SPACE,
    `path=${targetPath}`,
    `clawDir=${clawDir}`,
  );
  throw new PathNotInClawSpaceError(targetPath, clawDir);
}

/**
 * Create a Claw permission checker bound to a specific claw
 */
export function createClawPermissionChecker(
  options: ClawPermissionOptions,
): PermissionChecker {
  // phase 1783: deny / non-strict bypass 事件必须可观察——audit sink 是装配期必需
  // 契约；缺失（含 JS / as any 绕过编译期）在构造时显式失败，不留 optional silent path。
  if (!options.audit || typeof options.audit.write !== 'function') {
    throw new Error(
      'createClawPermissionChecker: audit sink is required — permission deny/bypass events must be observable',
    );
  }
  // phase 1818: canonical resolve capability 同样是构造期必需契约——缺失（含 JS / as any
  // 绕过编译期）显式失败，不构造退回词法 path.resolve 的弱 checker。
  if (!options.fs || typeof options.fs.resolve !== 'function') {
    throw new Error(
      'createClawPermissionChecker: fs with canonical resolve is required — lexical path.resolve fallback is not a valid containment check',
    );
  }
  return {
    checkRead: (targetPath: string) => checkReadPermission(targetPath, options),
    checkWrite: (targetPath: string) => checkWritePermission(targetPath, options),

    /**
     * Resolve and validate a path
     * @returns Absolute path if valid
     * @throws PermissionError if invalid
     */
    resolveAndCheck(
      relativePath: string,
      operation: 'read' | 'write'
    ): string {
      // phase 427 Step B (review medium permissions invariant): 始终经 owner fs
      // canonical resolve（phase 1818: 无 path.resolve fallback）、virtual FS /
      // rooted-fs 统一。
      const joined = path.join(options.clawDir, relativePath);
      let absolute: string;
      try {
        absolute = options.fs.resolve(joined);
      } catch (err) {
        // phase 1818: canonical resolve 的 containment 拒绝（PathGuardError）不直接上抛——
        // 下沉到 checkRead/checkWrite 单一 deny 点（getRelativeToClaw 的 PathGuardError→null
        // 语义），保持 deny vocabulary（PathNotInClawSpaceError）与 deny audit 不变；
        // 其余 I/O 类错误（EACCES/ENOENT/ELOOP…）继续上抛。
        if (!(err instanceof PathGuardError)) throw err;
        absolute = joined;
      }

      if (operation === 'read') {
        checkReadPermission(absolute, options);
      } else {
        checkWritePermission(absolute, options);
      }

      return absolute;
    },
  };
}
