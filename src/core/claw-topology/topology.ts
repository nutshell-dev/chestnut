import * as path from 'path';
import { CLAWS_DIR, enumerateClaws } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { makeClawId, CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { ClawEnumerationSnapshot, ClawTopology, ClawTopologyDeps } from './types.js';
import { ClawIdResolveError, CrossClawReadError } from './types.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from './audit-events.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';

export function enumerateOrdinaryClaws(fs: FileSystem, clawsDir: string) {
  const valid: ClawId[] = [];
  const invalid: { dir: string; reason: 'reserved_motion' | 'invalid_claw_id_format' }[] = [];
  for (const dir of enumerateClaws(fs, clawsDir)) {
    if (dir === MOTION_CLAW_ID) {
      invalid.push({ dir, reason: 'reserved_motion' });
      continue;
    }
    try {
      valid.push(makeClawId(dir));
    } catch {
      // silent: the rejected directory is retained as structured observation evidence.
      invalid.push({ dir, reason: 'invalid_claw_id_format' });
    }
  }
  return { valid, invalid };
}

export function createClawTopology(deps: ClawTopologyDeps): ClawTopology {
  const { fs, chestnutRoot, sink, motionDir } = deps;
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);

  const enumerateSnapshot = (): ClawEnumerationSnapshot => {
    const { valid, invalid } = enumerateOrdinaryClaws(fs, clawsDir);
    for (const { dir, reason } of invalid) {
      if (reason !== 'invalid_claw_id_format') continue;
      sink?.write(
        CLAW_TOPOLOGY_AUDIT_EVENTS.INVALID_CLAW_DIR,
        `dir=${dir}`,
        'reason=invalid_claw_id_format',
      );
    }
    return { valid: [MOTION_CLAW_ID, ...valid], invalid };
  };

  return {
    enumerate() {
      return [...enumerateSnapshot().valid] as ClawId[];
    },
    enumerateSnapshot,
    resolve(clawId) {
      if (clawId === MOTION_CLAW_ID) {
        return { kind: 'local', clawDir: path.join(chestnutRoot, motionDir) };
      }
      const clawDir = path.join(clawsDir, clawId);
      if (!fs.existsSync(clawDir)) {
        sink?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED, `clawId=${clawId}`, 'reason=not_found');
        throw new ClawIdResolveError(clawId, 'not_found');
      }
      // phase 944: ensure the resolved path is a directory, not a regular file
      if (!fs.isDirectorySync(clawDir)) {
        sink?.write(
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
          sink?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_READ_FAILED, `clawId=${clawId}`, `relPath=${relPath}`, `error=${String(err)}`);
          throw new CrossClawReadError(clawId, relPath, err);
        }
        // ENOENT：由下方 fs.read 产出既有缺文件错误语义
      }
      try {
        return await fs.read(absPath);
      } catch (err) {
        sink?.write(CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_READ_FAILED, `clawId=${clawId}`, `relPath=${relPath}`, `error=${String(err)}`);
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
