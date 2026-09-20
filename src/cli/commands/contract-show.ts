/**
 * Show contract state snapshot for a claw
 */

import * as yaml from 'js-yaml';
import type { ContractYaml, ProgressData } from '../../core/contract/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { createContractActionContext } from '../../assembly/index.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { makeContractId } from '../../core/contract/index.js';
// CLAWS_DIR and path removed: phase 263

/** contract-show evidence console.log 显示截断 cap（trigger=keep 同值、'…' Unicode append）*/
const EVIDENCE_PREVIEW_CHARS = 300;

export async function contractShowCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: string, contractId?: string): Promise<void> {
  // phase 1874 Step F: 装配归 Assembly 窄入口；show 结束时 dispose
  const action = await createContractActionContext(deps, clawId);
  const manager = action.system;
  try {

    // 若未指定 contractId，用 active 契约
    let resolvedId = contractId;
    if (!resolvedId) {
      const active = await manager.loadActive();
      if (!active) {
        console.log(`No active contract for claw ${clawId}`);
        return;
      }
      resolvedId = active.id;
    }

    // 读契约 YAML（active/paused/archive 均可）
    let contractYaml: ContractYaml;
    try {
      const raw = await manager.readContractYamlRaw(makeContractId(resolvedId));
      contractYaml = yaml.load(raw) as ContractYaml;
    } catch (err) {
      // phase 906 r115 O fork (audit-2026-05-16 NEW.P2.6): preserve Error cause chain
      throw new CliError(
        `Contract "${resolvedId}" not found for claw ${clawId}`,
        { cause: err },
      );
    }

    // 读 progress（active/archive 当前语义；legacy paused 由 detector 单独展示）
    let progress: ProgressData | null = null;
    try {
      progress = await manager.getProgress(makeContractId(resolvedId));
    } catch (err) {
      // phase 906 r115 O fork (audit-2026-05-16 NEW.P2.6): narrow to ENOENT only
      // file missing = expected (注释原意「progress 文件缺失」)，其他错误 = real bug bubble
      if (!isFileNotFound(err)) {
        throw err;
      }
    }

    // phase 1123 Step D: legacy paused contracts are observable but not current
    if (!progress) {
      const legacyPaused = await manager.findLegacyPausedContracts();
      const legacy = legacyPaused.find(r => r.contractId === resolvedId);
      if (legacy) {
        console.log(`Contract: ${resolvedId}`);
        console.log(`Status: legacy paused (read-only)`);
        console.log(`Source: ${legacy.sourcePath}`);
        return;
      }
    }

    console.log(`Contract: ${resolvedId}`);
    console.log(`Title: ${contractYaml.title}`);
    console.log(`Goal: ${contractYaml.goal}`);
    console.log(`Status: ${progress?.status ?? 'unknown'}`);
    if (progress?.started_at) console.log(`Started: ${progress.started_at}`);
    console.log('');
    console.log('Subtasks:');

    for (const subtask of contractYaml.subtasks) {
      const st = progress?.subtasks[subtask.id];
      const status = st?.status ?? 'pending';
      const label = `[${status}]`.padEnd(13);
      console.log(`  ${label} ${subtask.id}: ${subtask.description}`);
      if (st?.evidence) {
        const ev = st.evidence.length > EVIDENCE_PREVIEW_CHARS ? st.evidence.slice(0, EVIDENCE_PREVIEW_CHARS) + '…' : st.evidence;
        console.log(`               Evidence: ${ev}`);
      }
      if (st?.last_failed_feedback) {
        const feedbackDisplay = st.last_failed_feedback.feedback;
        console.log(`               Last feedback: ${feedbackDisplay}`);
      }
      if (st?.retry_count) {
        console.log(`               Retries: ${st.retry_count}`);
      }
    }
  } finally {
    action.dispose();
  }
}
