import { formatErr } from '../foundation/node-utils/index.js';

import type { FileSystem } from '../foundation/fs/index.js';

import { type AuditLog, AUDIT_FILE } from '../foundation/audit/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import { ASSEMBLY_STREAM_EVENTS } from './stream-events.js';

import { isFileNotFound } from '../foundation/fs/index.js';




import type { CoreInfraOutput } from './core-infrastructure.js';

import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';









import { cleanupOrphanedTemp } from './cleanup.js';

import type { AssembleConfig, AssembleOverrides, AssemblyContributions, Instances } from './types.js';
import { createCoreInfrastructure } from './core-infrastructure.js';
import { createBusinessSystems } from './business-systems.js';
import { createRuntimeAssembly } from './runtime-assembly.js';
import { createMotionAddons } from './motion-addons.js';
import { createAssemblyRollback } from './rollback.js';
import { disassemble } from './disassemble.js';



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
      const parts = lastLine.split('\t');
      // phase 1124: 兼容 phase 1125 起的 seq=N col（mirror daemon/last-exit-summary.ts:71-75）
      let typeIdx = 1;
      if (parts[1]?.startsWith('seq=') && parts.length >= 3) typeIdx = 2;
      const type = parts[typeIdx];
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
export async function assemble(
  config: AssembleConfig,
  contributions?: AssemblyContributions,
  overrides?: AssembleOverrides,
): Promise<Instances> {
  const startTime = Date.now();
  const { identity, clawId, clawDir } = config;
  // phase 1872 Step B: 非法输入（claw 缺 clawConfig / motion 带 clawConfig）由
  // AssembleConfig 判别联合编译期拒绝，运行时检查退役。
  const isMotion = identity === 'motion';

  let core: CoreInfraOutput | undefined;

  let streamWriter: StreamWriter | undefined;
  // Phase 1200: contractSystemCache dispose hook (motion lifecycle end-of-life)
  // phase 1808 Step B: typed dispose outcome（partial_failure 携 clawId/error 证据）
  let disposeContractSystems: (() => Promise<import('./contract-bridge-dispose.js').ContractBridgeDisposeResult>) | undefined;

  // phase 1872 Step C: 未提交装配 rollback 注册表——按构造序登记、失败时反序
  // best-effort teardown；次生失败经 audit 留证（core 未就绪的早期失败降级 stderr），
  // 原 error 由下方 rethrow 不丢。成功路径不执行（teardown 走 disassemble）。
  const rollback = createAssemblyRollback((step, error) => {
    if (core) {
      try {
        core.auditWriter.write(
          ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
          `module=rollback`,
          `step=${step}`,
          `reason=${formatErr(error)}`,
        );
        return;
      } catch {
        // silent: audit 写入失败 → 降级 stderr 兜底（次生失败信息不丢，见下一行）。
      }
    }
    process.stderr.write(`[assembly] rollback teardown failed step=${step}: ${formatErr(error)}\n`);
  });

  try {
    const coreInfra = await createCoreInfrastructure({
      config,
      createSkillSystem: overrides?.createSkillSystem,
      contributions,
    });
    core = coreInfra;
    // 登记顺序 = 构造序（audit_writer 先登记 → 反序 teardown 最后释放，供其余次生失败留证）。
    // 注：createCoreInfrastructure 内部失败由其内部注册表自清（不返回半成品）。
    rollback.register('audit_writer', () => coreInfra.auditWriter.dispose?.());
    rollback.register('stream_writer', () => coreInfra.streamWriter.close());
    rollback.register('llm', () => coreInfra.llm.close());
    rollback.register('contract_manager', () => coreInfra.contractManager.close());
    const {
      systemFs,
      auditWriter, processManager,
    } = coreInfra;

    // §A.6 selfInboxDir 提前到 taskSystem / callback 定义前（双链路保险 / cron job 注册块同步引用）
    // 详 src/assembly/business-systems.ts (phase 37 rename motionInbox{Dir} → selfInbox{Dir} 命名 hygiene)
    const business = await createBusinessSystems({ core: coreInfra, contributions });
    rollback.register('task_system', () => business.taskSystem.shutdown());

    const { snapshot, streamWriter: sw, runtime, executionRecovery, recoverySession, eventLoop } = await createRuntimeAssembly({ core: coreInfra, business, config });
    streamWriter = sw;
    rollback.register('runtime', () => runtime.stop());

    // 孤儿临时文件清理（从 Runtime.initialize 搬来；Assembly 负责一次性的启动清理）
    await cleanupOrphanedTemp(systemFs, clawDir, startTime).catch((err: unknown) => {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.CLEANUP_TEMP_FILES_FAILED, `reason=${formatErr(err)}`);
    });

    let gateway: import('../core/gateway/index.js').Gateway | undefined;
    let heartbeat: import('../core/heartbeat/index.js').Heartbeat | undefined;
    let cronRunner: import('../foundation/cron/index.js').CronRunner | undefined;
    if (isMotion) {
      const motionAddons = await createMotionAddons({ core, business, runtime, config, streamWriter: streamWriter! });
      gateway = motionAddons.gateway;
      heartbeat = motionAddons.heartbeat;
      cronRunner = motionAddons.cronRunner;
      disposeContractSystems = motionAddons.disposeContractSystems;
      // phase 1872 Step C: motion 面已构造资源纳入反序 teardown（heartbeat 无 teardown API，
      // 不外泄 timer 句柄、不注册；gateway/cron/bridge 按构造序登记）。
      const gw = motionAddons.gateway;
      const cr = motionAddons.cronRunner;
      const bridgeDispose = motionAddons.disposeContractSystems;
      if (gw) rollback.register('gateway', () => gw.stop());
      if (cr) rollback.register('cron_runner', () => cr.stop());
      if (bridgeDispose) rollback.register('contract_bridge', () => bridgeDispose());
    }

    // --- 5. detectUncleanExit (daemon.ts L152) ---
    detectUncleanExit(clawDir, auditWriter, systemFs);

    // --- 8. 契约 §4 audit daemon_started ---
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_STARTED, `clawId=${clawId}`, `pid=${process.pid}`);
    streamWriter!.write({ ts: Date.now(), type: ASSEMBLY_STREAM_EVENTS.DAEMON_STARTED, clawId, pid: process.pid });

    return {
      runtime,
      eventLoop,
      streamWriter: streamWriter!,
      snapshot,
      processManager,
      auditWriter,
      heartbeat,
      executionRecovery,
      recoverySession,
      dispose: (signal: string) => disassemble({
        gateway,
        runtime,
        streamWriter: streamWriter!,
        auditWriter,
        cronRunner,
        disposeContractSystems,
      }, signal),
    };
  } catch (e) {
    // phase 1872 Step C: 未提交装配反序 teardown（含 llm/streamWriter 的旧空 catch 路径；
    // 次生失败 audit/stderr 留证）。原 error 原样重抛（cause 链不丢）。
    await rollback.run();
    throw e;
  }
}
