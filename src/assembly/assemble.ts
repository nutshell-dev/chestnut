import { formatErr } from '../foundation/utils/index.js';

import type { FileSystem } from '../foundation/fs/index.js';

import { type AuditLog, AUDIT_FILE } from '../foundation/audit/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';

import { isFileNotFound } from '../foundation/fs/index.js';




import type { CoreInfraOutput } from './core-infrastructure.js';

import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import { makeClawId } from '../foundation/identity/index.js';









import { cleanupOrphanedTemp } from './cleanup.js';

import type { AssembleConfig, AssembleDeps, Instances } from './types.js';
import { createCoreInfrastructure } from './core-infrastructure.js';
import { createBusinessSystems } from './business-systems.js';
import { createRuntimeAssembly } from './runtime-assembly.js';
import { createMotionAddons } from './motion-addons.js';



// 内部 helper（从 daemon.ts L42-75 搬入）
export function detectUncleanExit(_auditDir: string, auditWriter: AuditLog, fs: FileSystem): void {
  if (!fs.existsSync(AUDIT_FILE)) return;
  try {
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size === 0) return;
    const chunkSize = 4096;
    const offset = Math.max(0, stat.size - chunkSize);
    const buf = fs.readBytesSync(AUDIT_FILE, offset, stat.size);
    const chunk = buf.toString('utf-8');
      const lastLine = chunk.split('\n').filter(Boolean).at(-1) ?? '';
      const type = lastLine.split('\t')[1];
      if (
        type === 'daemon_stop' ||
        type === 'daemon_unclean_exit' ||
        type === 'daemon_crash'
      ) return;
      const lastTs = lastLine.split('\t')[0] ?? new Date().toISOString();
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_UNCLEAN_EXIT, `last_ts=${lastTs}`);
  } catch (err: unknown) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(err)) {
      const code = (err as { code?: string })?.code;
      const message = formatErr(err);
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
        `module=detect_unclean_exit`,
        `phase=detect`,
        `reason=${code || message}`,
      );
    }
  }
}

// phase 1382 audit-trail B-2 REFRAMED note: detectUncleanExit (above) returns void early on no-op
// (file 0/empty/clean-stop) — NOT error path. assemble (below) throws on validation failure (real error).
// Two functions = two patterns by-design; audit B-2 framing「throw + return error model mix」reframe-out.
export async function assemble(config: AssembleConfig, deps?: AssembleDeps): Promise<Instances> {
  const { identity, clawId, clawDir } = config;
  if (identity === 'claw' && !config.clawConfig) {
    throw new Error('clawConfig is required when identity=claw');
  }
  const isMotion = identity === 'motion';

  const lockState = { acquired: false };
  let core: CoreInfraOutput | undefined;

  let streamWriter: StreamWriter | undefined;
  // Phase 1200: contractSystemCache dispose hook (motion lifecycle end-of-life)
  let disposeContractSystems: (() => Promise<void>) | undefined;

  try {
    core = await createCoreInfrastructure({ config, lockState, createSkillSystem: deps?.createSkillSystem });
    const {
      systemFs,
      auditWriter, processManager,
    } = core;

    // §A.6 selfInboxDir 提前到 taskSystem / callback 定义前（双链路保险 / cron job 注册块同步引用）
    // 详 src/assembly/business-systems.ts (phase 37 rename motionInbox{Dir} → selfInbox{Dir} 命名 hygiene)
    const business = await createBusinessSystems({ core });
    const {
      evolutionSystem,
    } = business;

    const { snapshot, streamWriter: sw, runtime } = await createRuntimeAssembly({ core, business, config });
    streamWriter = sw;

    // 孤儿临时文件清理（从 Runtime.initialize 搬来；Assembly 负责一次性的启动清理）
    cleanupOrphanedTemp(systemFs, clawDir).catch((err: unknown) => {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.CLEANUP_TEMP_FILES_FAILED, `reason=${formatErr(err)}`);
    });

    let gateway: import('../core/gateway/index.js').Gateway | undefined;
    let heartbeat: import('../core/runtime/index.js').Heartbeat | undefined;
    let cronRunner: import('../core/cron/index.js').CronRunner | undefined;
    if (isMotion) {
      const motionAddons = await createMotionAddons({ core, business, runtime, config, streamWriter: streamWriter! });
      gateway = motionAddons.gateway;
      heartbeat = motionAddons.heartbeat;
      cronRunner = motionAddons.cronRunner;
      disposeContractSystems = motionAddons.disposeContractSystems;
    }

    // --- 5. detectUncleanExit (daemon.ts L152) ---
    detectUncleanExit(clawDir, auditWriter, systemFs);

    // --- 8. 契约 §4 audit daemon_started ---
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_STARTED, `clawId=${clawId}`, `pid=${process.pid}`);
    streamWriter!.write({ ts: Date.now(), type: 'daemon_started', clawId, pid: process.pid });

    return {
      clawId: config.clawId,
      runtime,
      streamWriter: streamWriter!,
      snapshot,
      processManager,
      auditWriter,
      cronRunner,
      heartbeat,
      gateway,
      evolutionSystem,
      disposeContractSystems,
    };
  } catch (e) {
    // Best-effort cleanup of already-constructed resources
    streamWriter?.close?.();
    core?.llm?.close()?.catch(() => {
      // silent: assemble throw 兜底 teardown 路径，原 error e 在末尾 throw 不丢失；llm.close 异步失败属次生 error，无 auditWriter 可信通道（catch 内 auditWriter 自身可能未完成构造）
    });
    if (lockState.acquired && core) {
      try {
        core.processManager.releaseLock(makeClawId(clawId));
      } catch (releaseErr) {
        core.auditWriter.write(
          ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
          `module=lockfile_release`,
          `phase=assemble_throw_cleanup`,
          `reason=${formatErr(releaseErr)}`,
        );
      }
    }
    throw e;
  }
}


