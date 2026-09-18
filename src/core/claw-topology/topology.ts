import * as path from 'path';
import { CLAWS_DIR, enumerateClaws } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { makeClawId, CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { ClawTopology, ClawTopologyDeps } from './types.js';
import { ClawIdResolveError, CrossClawReadError } from './types.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from './audit-events.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';

export function createClawTopology(deps: ClawTopologyDeps): ClawTopology {
  const { fs, chestnutRoot, audit, motionDir } = deps;
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);

  return {
    enumerate() {
      // phase 944: isolate invalid claw directory names so one bad entry does not
      // abort enumeration of the remaining valid claws.
      const rawNames = enumerateClaws(fs, clawsDir);
      const clawIds: ClawId[] = [];
      for (const name of rawNames) {
        try {
          clawIds.push(makeClawId(name));
        } catch {
          audit?.write(
            CLAW_TOPOLOGY_AUDIT_EVENTS.INVALID_CLAW_DIR,
            `dir=${name}`,
            'reason=invalid_claw_id_format',
          );
          // skip invalid entry, continue enumerating valid claws
        }
      }
      return [MOTION_CLAW_ID, ...clawIds];
    },
    resolve(clawId) {
      if (clawId === MOTION_CLAW_ID) {
        return { kind: 'local', clawDir: path.join(chestnutRoot, motionDir) };
      }
      const clawDir = path.join(clawsDir, clawId);
      if (!fs.existsSync(clawDir)) {
        audit?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED, `clawId=${clawId}`, 'reason=not_found');
        throw new ClawIdResolveError(clawId, 'not_found');
      }
      // phase 944: ensure the resolved path is a directory, not a regular file
      if (!fs.isDirectorySync(clawDir)) {
        audit?.write(
          CLAW_TOPOLOGY_AUDIT_EVENTS.CLAW_DIR_NOT_DIRECTORY,
          `clawId=${clawId}`,
          `path=${clawDir}`,
        );
        throw new ClawIdResolveError(clawId, 'not_a_directory');
      }
      return { kind: 'local', clawDir };
    },
    async read(clawId, relPath) {
      const location = this.resolve(clawId);
      if (location.kind !== 'local') {
        throw new CrossClawReadError(clawId, relPath, 'remote location not supported in single-host mode');
      }
      // Resolve the full path within clawspace, then check it's contained within clawDir.
      const absPath = path.resolve(path.join(location.clawDir, CLAWSPACE_DIR, relPath));
      const clawspaceRoot = path.resolve(path.join(location.clawDir, CLAWSPACE_DIR)) + path.sep;
      if (!absPath.startsWith(clawspaceRoot)) {
        throw new CrossClawReadError(clawId, relPath, 'path outside clawspace');
      }
      // phase 1813 Step B (CT-D6): canonical containment——词法 startsWith 只拦 '..'
      // 穿越，拦不住 clawspace 内 symlink 外逃（NodeFileSystem 的 baseDir 级 guard 只看
      // chestnutRoot 粒度、不管 clawspace）。读取前双端 realpath 比对，外逃必拒绝；
      // ENOENT（目标或 ancestor 不存在）落既有 reader 错误路径透传，不误报 escape。
      try {
        const clawspaceReal = await fs.realpath(path.join(location.clawDir, CLAWSPACE_DIR));
        const targetReal = await fs.realpath(absPath);
        if (targetReal !== clawspaceReal && !targetReal.startsWith(clawspaceReal + path.sep)) {
          throw new CrossClawReadError(clawId, relPath, 'symlink escape');
        }
      } catch (err) {
        if (err instanceof CrossClawReadError) throw err;
        if (!isFileNotFound(err)) {
          // EACCES/ELOOP 等 canonical 观察失败：与 read 失败同语义上抛，不回退词法判断
          audit?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_READ_FAILED, `clawId=${clawId}`, `relPath=${relPath}`, `error=${String(err)}`);
          throw new CrossClawReadError(clawId, relPath, err);
        }
        // ENOENT：由下方 fs.read 产出既有缺文件错误语义
      }
      try {
        return await fs.read(absPath);
      } catch (err) {
        audit?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_READ_FAILED, `clawId=${clawId}`, `relPath=${relPath}`, `error=${String(err)}`);
        throw new CrossClawReadError(clawId, relPath, err);
      }
    },
    async readJSON(clawId: ClawId, relPath: string): Promise<unknown> {
      const content = await this.read(clawId, relPath);
      // phase 1811 Step B: 不 cast——parse 结果以 unknown 交付，业务类型由
      // caller 在 owner 边界经 schema/decoder 获得。
      return JSON.parse(content) as unknown;
    },
  };
}
