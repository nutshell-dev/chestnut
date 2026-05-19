/**
 * createClawPermissionChecker — 路径级权限控制测试
 *
 * 覆盖：
 * - checkRead：clawDir 内/外，路径穿越
 * - checkWrite：可写路径，系统只读路径，clawDir 外
 * - resolveAndCheck：相对路径解析，穿越阻断
 * - strict: false 模式
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import {
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
} from '../../../src/types/errors.js';

const CLAW_DIR = '/tmp/test-claw';

describe('createClawPermissionChecker', () => {
  // =========================================================================
  // checkRead
  // =========================================================================
  describe('checkRead', () => {
    it('clawDir 内的路径允许读', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkRead(`${CLAW_DIR}/memory/notes.md`)).not.toThrow();
    });

    it('clawDir 本身允许读', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkRead(CLAW_DIR)).not.toThrow();
    });

    it('clawDir 外的路径抛出 PathNotInClawSpaceError', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkRead('/etc/passwd'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('路径穿越（../）被阻断', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      // path.resolve 会展开穿越，最终落在 clawDir 外
      const traversal = path.resolve(CLAW_DIR, '../../etc/passwd');
      expect(() => checker.checkRead(traversal))
        .toThrow(PathNotInClawSpaceError);
    });

    it('strict: false 时任意路径均允许', () => {
      const audit = { write: vi.fn() };
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR, strict: false, audit: audit as any });
      expect(() => checker.checkRead('/etc/shadow')).not.toThrow();
      expect(() => checker.checkRead('/root/.ssh/id_rsa')).not.toThrow();
      expect(audit.write).toHaveBeenCalledWith('permission_strict_disabled', 'Non-strict mode active — all permission checks bypassed');
    });
  });

  // =========================================================================
  // checkWrite
  // =========================================================================
  describe('checkWrite', () => {
    it('可写路径（clawspace/）允许写', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkWrite(`${CLAW_DIR}/clawspace/output.txt`)).not.toThrow();
    });

    it('memory/ 允许写', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkWrite(`${CLAW_DIR}/memory/notes.md`)).not.toThrow();
    });

    it('AGENTS.md 系统文件抛出 WriteOperationForbiddenError', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkWrite(`${CLAW_DIR}/AGENTS.md`))
        .toThrow(WriteOperationForbiddenError);
    });

    it('dialog/ 系统目录抛出 WriteOperationForbiddenError', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkWrite(`${CLAW_DIR}/dialog/session.json`))
        .toThrow(WriteOperationForbiddenError);
    });

    it('config.yaml 系统文件抛出 WriteOperationForbiddenError', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkWrite(`${CLAW_DIR}/config.yaml`))
        .toThrow(WriteOperationForbiddenError);
    });

    it('clawDir 外的路径抛出 PathNotInClawSpaceError', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkWrite('/etc/cron.d/evil'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('路径穿越写入被阻断', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      const traversal = path.resolve(CLAW_DIR, '../../../etc/crontab');
      expect(() => checker.checkWrite(traversal))
        .toThrow(PathNotInClawSpaceError);
    });

    it('clawDir 内非系统路径允许写（fallback）', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      // logs/ 在 WRITABLE_PATHS 中
      expect(() => checker.checkWrite(`${CLAW_DIR}/logs/app.log`)).not.toThrow();
    });

    it('tasks/subagents/<id>/ 写入允许（α 简化 / 所有 callerType）', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.checkWrite(`${CLAW_DIR}/tasks/subagents/abc/file.txt`)).not.toThrow();
    });

    it('strict: false 时写系统路径也允许', () => {
      const audit = { write: vi.fn() };
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR, strict: false, audit: audit as any });
      expect(() => checker.checkWrite(`${CLAW_DIR}/dialog/session.json`)).not.toThrow();
      expect(() => checker.checkWrite('/etc/passwd')).not.toThrow();
      expect(audit.write).toHaveBeenCalledWith('permission_strict_disabled', 'Non-strict mode active — all permission checks bypassed');
    });

    it('自定义 systemPaths 覆盖默认值', () => {
      const checker = createClawPermissionChecker({
        clawDir: CLAW_DIR,
        systemPaths: ['custom-readonly'],
      });
      // AGENTS.md 不在 WRITABLE_PATHS 中，默认拒绝（explicit allow list）
      expect(() => checker.checkWrite(`${CLAW_DIR}/AGENTS.md`))
        .toThrow(WriteOperationForbiddenError);
      // 自定义 custom-readonly 只读
      expect(() => checker.checkWrite(`${CLAW_DIR}/custom-readonly/file.txt`))
        .toThrow(WriteOperationForbiddenError);
    });
  });

  // =========================================================================
  // resolveAndCheck
  // =========================================================================
  describe('resolveAndCheck', () => {
    it('相对路径解析为 clawDir 内的绝对路径', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      const result = checker.resolveAndCheck('clawspace/output.txt', 'write');
      expect(result).toBe(path.resolve(CLAW_DIR, 'clawspace/output.txt'));
    });

    it('相对路径穿越被 resolveAndCheck 阻断（write）', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.resolveAndCheck('../../../etc/passwd', 'write'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('相对路径穿越被 resolveAndCheck 阻断（read）', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.resolveAndCheck('../../other-claw/secret.md', 'read'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('系统路径相对写被阻断', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      expect(() => checker.resolveAndCheck('dialog/session.json', 'write'))
        .toThrow(WriteOperationForbiddenError);
    });

    it('合法相对读路径返回绝对路径', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      const result = checker.resolveAndCheck('memory/notes.md', 'read');
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toContain(CLAW_DIR);
    });
  });

  // =========================================================================
  // 错误类型与附带信息
  // =========================================================================
  describe('Error details', () => {
    it('PathNotInClawSpaceError 携带路径和 clawDir 信息', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      let err: unknown;
      try {
        checker.checkRead('/etc/passwd');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PathNotInClawSpaceError);
      const clawErr = err as PathNotInClawSpaceError;
      expect(clawErr.context?.path).toBe('/etc/passwd');
      expect(clawErr.context?.clawDir).toBe(CLAW_DIR);
    });

    it('WriteOperationForbiddenError 携带 toolName 和 profile 信息', () => {
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR });
      let err: unknown;
      try {
        checker.checkWrite(`${CLAW_DIR}/AGENTS.md`);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WriteOperationForbiddenError);
      const writeErr = err as WriteOperationForbiddenError;
      expect(writeErr.context?.toolName).toBe('write');
      expect(writeErr.context?.profile).toBe('system');
    });
  });
});
