import { formatErr } from "../foundation/node-utils/index.js";
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { Runtime } from '../core/runtime/index.js';
import type { CronRunner } from '../foundation/cron/index.js';
import type { Gateway } from '../core/gateway/index.js';
import type { ContractBridgeDisposeResult } from './contract-bridge-dispose.js';

/** Assembly-private teardown handles. This type is deliberately absent from the barrel. */
interface DisassemblyResources {
  readonly gateway?: Gateway;
  readonly runtime: Runtime;
  readonly streamWriter: StreamWriter;
  readonly auditWriter: AuditLog;
  readonly cronRunner?: CronRunner;
  readonly disposeContractSystems?: () => Promise<ContractBridgeDisposeResult>;
}

export async function disassemble(instances: DisassemblyResources, signal: string): Promise<void> {
  const { gateway, runtime, streamWriter, auditWriter, cronRunner, disposeContractSystems } = instances;

  // Step 0: dispose contractSystemCache (motion lifecycle end-of-life, phase 1200)
  try {
    const result = await disposeContractSystems?.();
    // phase 1808 Step B：partial_failure 不再静默——按既有 per-step 模式 audit，
    // 逐条失败携带 clawId identity 与原始 error 投影。
    if (result?.kind === 'partial_failure') {
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
        `step=dispose_contract_systems`,
        `result=partial_failure`,
        ...result.failures.map(f => `failure=${f.clawId}:${f.error}`),
      );
    }
  } catch (e) {
    auditWriter.write(
      ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
      `step=dispose_contract_systems`,
      `reason=${_reason(e)}`,
    );
  }

  // Step 1: gateway?.stop()（async；motion only；最前位置——切断对外推送）
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

  // phase 1476: Step 2.5 final outbox drain 砍（drain-outboxes 全砍 / pull 模型替 push）
  // post-cron-stop subagent 写 outbox 留 outbox/pending、motion 下次启动 outbox-summary cron 扫到 → 通知 motion CLI 拉。

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

  // Step 5: audit daemon_stop（最后）
  auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_STOP, `signal=${signal.toLowerCase()}`);
}

function _reason(e: unknown): string {
  return formatErr(e);
}
