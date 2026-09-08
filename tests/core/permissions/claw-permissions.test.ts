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
import { makeMockAudit } from '../../helpers/audit.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import {
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
} from '../../../src/core/permissions/errors.js';

const CLAW_DIR = '/tmp/test-claw';

describe('createClawPermissionChecker', () => {
  // =========================================================================
  // checkRead
  // =========================================================================
  describe('checkRead', () => {
    it('clawDir 内的路径允许读', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkRead(`${CLAW_DIR}/memory/notes.md`)).not.toThrow();
    });

    it('clawDir 本身允许读', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkRead(CLAW_DIR)).not.toThrow();
    });

    it('clawDir 外的路径抛出 PathNotInClawSpaceError', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkRead('/etc/passwd'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('路径穿越（../）被阻断', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      // path.resolve 会展开穿越，最终落在 clawDir 外
      const traversal = path.resolve(CLAW_DIR, '../../etc/passwd');
      expect(() => checker.checkRead(traversal))
        .toThrow(PathNotInClawSpaceError);
    });

    it('strict: false 时任意路径均允许', () => {
      const audit = makeMockAudit();
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR, strict: false, audit, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkRead('/etc/shadow')).not.toThrow();
      expect(() => checker.checkRead('/root/.ssh/id_rsa')).not.toThrow();
      // phase 713: raw msg 改 'reason=' prefix
      expect(audit.write).toHaveBeenCalledWith('permission_strict_disabled', 'reason=non_strict_mode_bypass');
    });

    it('propagates EACCES from fs.resolve instead of treating it as outside claw', () => {
      const eaccesErr = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const mockFs = {
        resolve: vi.fn().mockImplementation(() => { throw eaccesErr; }),
      };
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: mockFs });
      expect(() => checker.checkRead(`${CLAW_DIR}/memory/notes.md`)).toThrow(eaccesErr);
    });

    it('propagates EPERM from fs.resolve instead of treating it as outside claw', () => {
      const epermErr = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const mockFs = {
        resolve: vi.fn().mockImplementation(() => { throw epermErr; }),
      };
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: mockFs });
      expect(() => checker.checkRead(`${CLAW_DIR}/memory/notes.md`)).toThrow(epermErr);
    });

    it('propagates EROFS from fs.resolve instead of treating it as outside claw', () => {
      const erofsErr = Object.assign(new Error('read-only file system'), { code: 'EROFS' });
      const mockFs = {
        resolve: vi.fn().mockImplementation(() => { throw erofsErr; }),
      };
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: mockFs });
      expect(() => checker.checkRead(`${CLAW_DIR}/memory/notes.md`)).toThrow(erofsErr);
    });

    it('propagates ENOENT from fs.resolve instead of returning null', () => {
      const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const mockFs = {
        resolve: vi.fn().mockImplementation(() => { throw enoentErr; }),
      };
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: mockFs });
      expect(() => checker.checkRead(`${CLAW_DIR}/memory/notes.md`)).toThrow(enoentErr);
    });
  });

  // =========================================================================
  // checkWrite
  // =========================================================================
  describe('checkWrite', () => {
    it('可写路径（clawspace/）允许写', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite(`${CLAW_DIR}/clawspace/output.txt`)).not.toThrow();
    });

    it('memory/ 允许写', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite(`${CLAW_DIR}/memory/notes.md`)).not.toThrow();
    });

    it('AGENTS.md 系统文件抛出 WriteOperationForbiddenError', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite(`${CLAW_DIR}/AGENTS.md`))
        .toThrow(WriteOperationForbiddenError);
    });

    it('dialog/ 系统目录抛出 WriteOperationForbiddenError', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite(`${CLAW_DIR}/dialog/session.json`))
        .toThrow(WriteOperationForbiddenError);
    });

    it('config.yaml 系统文件抛出 WriteOperationForbiddenError', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite(`${CLAW_DIR}/config.yaml`))
        .toThrow(WriteOperationForbiddenError);
    });

    it('clawDir 外的路径抛出 PathNotInClawSpaceError', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite('/etc/cron.d/evil'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('路径穿越写入被阻断', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      const traversal = path.resolve(CLAW_DIR, '../../../etc/crontab');
      expect(() => checker.checkWrite(traversal))
        .toThrow(PathNotInClawSpaceError);
    });

    it('clawDir 内非系统路径允许写（fallback）', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      // logs/ 在 WRITABLE_PATHS 中
      expect(() => checker.checkWrite(`${CLAW_DIR}/logs/app.log`)).not.toThrow();
    });

    it('tasks/subagents/<id>/ 写入允许（α 简化 / 所有 callerType）', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite(`${CLAW_DIR}/tasks/subagents/abc/file.txt`)).not.toThrow();
    });

    it('strict: false 时写系统路径也允许', () => {
      const audit = makeMockAudit();
      const checker = createClawPermissionChecker({ clawDir: CLAW_DIR, strict: false, audit, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.checkWrite(`${CLAW_DIR}/dialog/session.json`)).not.toThrow();
      expect(() => checker.checkWrite('/etc/passwd')).not.toThrow();
      // phase 713: raw msg 改 'reason=' prefix
      expect(audit.write).toHaveBeenCalledWith('permission_strict_disabled', 'reason=non_strict_mode_bypass');
    });

    it('自定义 systemPaths 覆盖默认值', () => {
      const checker = createClawPermissionChecker({
        audit: makeMockAudit(),
        clawDir: CLAW_DIR,
        fs: new NodeFileSystem({ baseDir: CLAW_DIR }),
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
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      const result = checker.resolveAndCheck('clawspace/output.txt', 'write');
      expect(result).toBe(path.resolve(CLAW_DIR, 'clawspace/output.txt'));
    });

    it('相对路径穿越被 resolveAndCheck 阻断（write）', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.resolveAndCheck('../../../etc/passwd', 'write'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('相对路径穿越被 resolveAndCheck 阻断（read）', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.resolveAndCheck('../../other-claw/secret.md', 'read'))
        .toThrow(PathNotInClawSpaceError);
    });

    it('系统路径相对写被阻断', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      expect(() => checker.resolveAndCheck('dialog/session.json', 'write'))
        .toThrow(WriteOperationForbiddenError);
    });

    it('合法相对读路径返回绝对路径', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      const result = checker.resolveAndCheck('memory/notes.md', 'read');
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toContain(CLAW_DIR);
    });
  });

  // =========================================================================
  // phase 1783: audit sink 必需契约——deny / bypass 事件无 optional silent path
  // =========================================================================
  describe('audit sink contract (phase 1783)', () => {
    it('缺失 audit sink → factory 构造时显式抛错', () => {
      expect(() =>
        createClawPermissionChecker({ clawDir: CLAW_DIR } as unknown as Parameters<typeof createClawPermissionChecker>[0]),
      ).toThrow(/audit sink is required/);
    });

    it('audit 缺 write capability → factory 构造时显式抛错', () => {
      expect(() =>
        createClawPermissionChecker({ clawDir: CLAW_DIR, audit: {} } as unknown as Parameters<typeof createClawPermissionChecker>[0]),
      ).toThrow(/audit sink is required/);
    });

    // phase 1818: canonical resolve capability 与 audit sink 同为构造期必需契约
    it('fs 缺失 → factory 构造时显式抛错（不构造词法 fallback 弱 checker）', () => {
      expect(() =>
        createClawPermissionChecker({ clawDir: CLAW_DIR, audit: makeMockAudit() } as unknown as Parameters<typeof createClawPermissionChecker>[0]),
      ).toThrow(/canonical resolve is required/);
    });

    it('fs 缺 resolve capability → factory 构造时显式抛错', () => {
      expect(() =>
        createClawPermissionChecker({ clawDir: CLAW_DIR, audit: makeMockAudit(), fs: {} } as unknown as Parameters<typeof createClawPermissionChecker>[0]),
      ).toThrow(/canonical resolve is required/);
    });

    it('四类 deny 事件均显式交付（无 silent path）', () => {
      const audit = makeMockAudit();
      const checker = createClawPermissionChecker({ audit, clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });

      // read outside claw space
      expect(() => checker.checkRead('/etc/passwd')).toThrow(PathNotInClawSpaceError);
      // write outside claw space
      expect(() => checker.checkWrite('/etc/cron.d/evil')).toThrow(PathNotInClawSpaceError);
      // write system readonly
      expect(() => checker.checkWrite(`${CLAW_DIR}/AGENTS.md`)).toThrow(WriteOperationForbiddenError);
      // write outside allowlist
      expect(() => checker.checkWrite(`${CLAW_DIR}/docker-compose.yml`)).toThrow(WriteOperationForbiddenError);

      expect(audit.write).toHaveBeenCalledWith(
        'permission_read_path_outside_claw_space', 'path=/etc/passwd', `clawDir=${CLAW_DIR}`,
      );
      expect(audit.write).toHaveBeenCalledWith(
        'permission_write_path_outside_claw_space', 'path=/etc/cron.d/evil', `clawDir=${CLAW_DIR}`,
      );
      expect(audit.write).toHaveBeenCalledWith(
        'permission_write_system_readonly', `path=${CLAW_DIR}/AGENTS.md`,
      );
      expect(audit.write).toHaveBeenCalledWith(
        'permission_write_outside_allowlist', `path=${CLAW_DIR}/docker-compose.yml`,
      );
    });
  });

  // =========================================================================
  // 错误类型与附带信息
  // =========================================================================
  describe('Error details', () => {
    it('PathNotInClawSpaceError 携带路径和 clawDir 信息', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
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

    it('WriteOperationForbiddenError 携带 targetPath 和 reason 信息', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      let err: unknown;
      try {
        checker.checkWrite(`${CLAW_DIR}/AGENTS.md`);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WriteOperationForbiddenError);
      const writeErr = err as WriteOperationForbiddenError;
      expect(writeErr.context?.targetPath).toBe(`${CLAW_DIR}/AGENTS.md`);
      expect(writeErr.context?.reason).toBe('system_readonly');
      expect(writeErr.message).toContain('cannot be written');
      expect(writeErr.message).toContain('system path');
    });

    it('WriteOperationForbiddenError outside_allowlist 携带正确 reason', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      let err: unknown;
      try {
        checker.checkWrite(`${CLAW_DIR}/docker-compose.yml`);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WriteOperationForbiddenError);
      const writeErr = err as WriteOperationForbiddenError;
      expect(writeErr.context?.targetPath).toBe(`${CLAW_DIR}/docker-compose.yml`);
      expect(writeErr.context?.reason).toBe('outside_allowlist');
      expect(writeErr.message).toContain('writable allowlist');
    });

    // phase 1819: hint 由真实 policy instance 派生，不再手写镜像
    it('outside_allowlist hint 携带真实 BASE policy paths（非手写镜像）', () => {
      const checker = createClawPermissionChecker({ audit: makeMockAudit(), clawDir: CLAW_DIR, fs: new NodeFileSystem({ baseDir: CLAW_DIR }) });
      let err: unknown;
      try {
        checker.checkWrite(`${CLAW_DIR}/docker-compose.yml`);
      } catch (e) {
        err = e;
      }
      const msg = (err as WriteOperationForbiddenError).message;
      // 真实静态 policy 成员在 hint 中
      expect(msg).toContain('MEMORY.md');
      expect(msg).toContain('clawspace');
      expect(msg).toContain('tasks/subagents');
      // 镜像 drift 证据不复现：过宽的 'tasks/' 整目录不出现在 hint
      expect(msg).not.toContain('tasks/,');
      // 无动态注入时 hint 不含 tasks/sync/*
      expect(msg).not.toContain('tasks/sync');
    });

    it('outside_allowlist hint 携带动态 taskSyncDirs（policy instance 派生）', () => {
      const checker = createClawPermissionChecker({
        audit: makeMockAudit(),
        clawDir: CLAW_DIR,
        fs: new NodeFileSystem({ baseDir: CLAW_DIR }),
        taskSyncDirs: ['tasks/sync/exec', 'tasks/sync/write'],
      });
      let err: unknown;
      try {
        checker.checkWrite(`${CLAW_DIR}/docker-compose.yml`);
      } catch (e) {
        err = e;
      }
      const msg = (err as WriteOperationForbiddenError).message;
      expect(msg).toContain('writable allowlist');
      expect(msg).toContain('tasks/sync/exec');
      expect(msg).toContain('tasks/sync/write');
      // hint 段只含相对 policy 路径，不回显绝对 clawDir（targetPath 部分不受此限）
      const hint = msg.split('writable allowlist')[1] ?? '';
      expect(hint).not.toContain(CLAW_DIR);
    });
  });
});
