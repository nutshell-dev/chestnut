import type { Instances } from './types.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';

export async function disassemble(instances: Instances, signal: string): Promise<void> {
  const { gateway, runtime, streamWriter, processManager, auditWriter, cronRunner, clawId, disposeContractSystems } = instances;

  // Step 0: dispose contractSystemCache (motion lifecycle end-of-life, phase 1200)
  try {
    await disposeContractSystems?.();
  } catch (e) {
    auditWriter.write(
      ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
      `step=dispose_contract_systems`,
      `reason=${_reason(e)}`,
    );
  }

  // Step 1: markNotReady (NEW phase 1114; 与 gateway.stop 切断对外推送 语义对称)
  // r127 C fork C.4: markNotReady 内部自负 audit (READY_MARK_REMOVED + context=remove_failed)、
  // 不抛 → caller try/catch 是 dead code (mirror phase 1032 cleanup.ts 模板)
  await processManager.markNotReady(clawId);

  // Step 1: gateway?.stop()（async；motion only；最前位置——切断对外推送 + cancel pending askUser）
  if (gateway) {
    try {
      await gateway.stop();
    } catch (e) {
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
        `step=gateway_stop`,
        `reason=${_reason(e)}`,
      );
    }
  }

  // Step 2: cronRunner?.stop()（phase 793: async with drain；motion + cron.enabled 才装）
  if (cronRunner) {
    try {
      await cronRunner.stop();
    } catch (e) {
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
        `step=cron_stop`,
        `reason=${_reason(e)}`,
      );
    }
  }

  // Step 3: runtime.stop()（async）
  try {
    await runtime.stop();
  } catch (e) {
    auditWriter.write(
      ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
      `step=runtime_stop`,
      `reason=${_reason(e)}`,
    );
  }

  // Step 4: streamWriter.close()（sync）
  try {
    streamWriter.close();
  } catch (e) {
    auditWriter.write(
      ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
      `step=stream_close`,
      `reason=${_reason(e)}`,
    );
  }

  // Step 5: processManager.releaseLock(clawId)（sync）
  try {
    processManager.releaseLock(clawId);
  } catch (e) {
    auditWriter.write(
      ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
      `step=release_lock`,
      `reason=${_reason(e)}`,
    );
  }

  // Step 6: audit daemon_stop（最后）
  auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_STOP, `signal=${signal.toLowerCase()}`);
}

function _reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
